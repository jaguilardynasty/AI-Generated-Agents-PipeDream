export default defineComponent({
  name: "Analyze Contact Status (Clean JSON)",
  description: "Returns status + evidence for each contact (JSON-safe, trimmed, excludes @getdynasty.com evidence)",
  type: "action",
  props: {
    emailThreads: {
      type: "any",
      label: "Email Threads",
      description: "Object keyed by email (use steps.search_email_threads.$return_value.resultsByEmail)",
    },
    model: {
      type: "string",
      label: "OpenAI Model",
      options: ["gpt-4o", "gpt-4o-mini"],  // keep models that honor JSON mode
      default: "gpt-4o",
    },
    maxMessagesPerThread: {
      type: "integer",
      label: "Max messages (per email) to send to model",
      default: 30,
      optional: true,
    },
    maxCharsPerThread: {
      type: "integer",
      label: "Max characters (per email) to send to model",
      default: 12000,
      optional: true,
    },
  },

  async run({ $ }) {
    const threadsByEmail = this.emailThreads || {};
    const MAX_MSGS = this.maxMessagesPerThread || 30;
    const MAX_CHARS = this.maxCharsPerThread || 12000;

    const SYSTEM = `You analyze email conversations to determine customer status and engagement timeline.

CRITICAL: Respond with VALID JSON ONLY. No prose, no code fences.

Pick exactly one "status":
- "said they would sign up or pay now"
- "said they would sign up or pay at a later date"
- "said they were interested"
- "not interested or doubtful"
- "no messages found"

Status definitions:
- "said they would sign up or pay now": Contact explicitly indicated immediate readiness to purchase or sign up 
- "said they would sign up or pay at a later date": Contact expressed intent to purchase/sign up but specified a future timeframe 
- "said they were interested": Contact showed interest but hasn't said they would sign up yet.
- "not interested or doubtful": Contact seems doubtful as to wether they want to do this.
- "no messages found": No messages found for the contact


Rules:
- Use ONLY the other party's messages (exclude anything from *@getdynasty.com) for evidence/reasoning. Provide exact quotes from the messages.
- "lastCheckinDate": most recent meaningful interaction timestamp (YYYY-MM-DD HH:MM:SS) or null.
- "confidence": "high" | "medium" | "low".

Return EXACTLY:
{
  "status": "...",
  "lastCheckinDate": "YYYY-MM-DD HH:MM:SS or null",
  "evidence": "string",
  "confidence": "high" | "medium" | "low"
}
`;

    const stripHtml = (s = "") =>
      String(s)
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&amp;|&lt;|&gt;|&#39;|&quot;/g, (m) => ({
          "&nbsp;": " ",
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&#39;": "'",
          "&quot;": '"',
        }[m] || " "))
        .replace(/\s+/g, " ")
        .trim();

    const isOtherParty = (from = "") => !String(from).toLowerCase().includes("@getdynasty.com");

    const collectOtherPartyMessages = (value) => {
      // Supports raw string or Gmail-like thread object
      if (typeof value === "string") {
        return [{ date: "", from: "unknown", body: stripHtml(value) }];
      }

      const out = [];

      // shape 1: { threads: [ { messages: [...] }, ... ] }
      if (Array.isArray(value?.threads)) {
        for (const t of value.threads) {
          if (Array.isArray(t?.messages)) {
            for (const m of t.messages) {
              if (isOtherParty(m?.from)) {
                const body = stripHtml(m.plainBody || m.htmlBody || m.snippet || "");
                const date = m.date || m.internalDate || "";
                out.push({ date, from: m.from || "", body });
              }
            }
          }
        }
      }

      // shape 2: { messages: [...] }
      if (Array.isArray(value?.messages)) {
        for (const m of value.messages) {
          if (isOtherParty(m?.from)) {
            const body = stripHtml(m.plainBody || m.htmlBody || m.snippet || "");
            const date = m.date || m.internalDate || "";
            out.push({ date, from: m.from || "", body });
          }
        }
      }

      // fallback: stringify something unknown
      if (!out.length) {
        const s = stripHtml(JSON.stringify(value || ""));
        if (s) out.push({ date: "", from: "unknown", body: s });
      }

      // sort by time, keep the last N
      out.sort((a, b) => (Date.parse(a.date || "") || 0) - (Date.parse(b.date || "") || 0));
      return out.slice(Math.max(0, out.length - MAX_MSGS));
    };

    const toTranscript = (msgs) => {
      let text = msgs.map(m => {
        const d = Date.parse(m.date || "");
        const iso = isNaN(d) ? "unknown" : new Date(d).toISOString().replace("T", " ").slice(0, 19);
        return `[${iso}] ${m.from}: ${m.body}`;
      }).join("\n");
      if (text.length > MAX_CHARS) {
        text = text.slice(text.length - MAX_CHARS); // keep tail
      }
      return text || "(no messages from the other party)";
    };

    const validStatuses = new Set([
      "said they would sign up or pay now",
      "said they would sign up or pay at a later date",
      "said they were interested",
      "not interested or doubtful",
      "no messages found",
    ]);

    const results = [];
    const parsingErrors = [];

    for (const email of Object.keys(threadsByEmail)) {
      const raw = threadsByEmail[email];

      try {
        const msgs = collectOtherPartyMessages(raw);
        const transcript = toTranscript(msgs);

        const userContent = `Analyze this email thread for ${email}.\n\nONLY non-@getdynasty.com messages are included below.\n\nTHREAD:\n${transcript}`;

        // Prefer new client
        let resp;
        try {
          resp = await $.openai.chat.completions.create({
            model: this.model,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 500,
          });
        } catch {
          // Fallback to legacy client name if needed
          resp = await $.services.openai.completions.create({
            model: this.model,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 500,
          });
        }

        let text = resp?.choices?.[0]?.message?.content ?? "";
        text = text.trim();
        if (text.startsWith("```")) {
          text = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
          if (!validStatuses.has(parsed.status)) throw new Error("Invalid or missing status");
          if (!["high", "medium", "low"].includes(parsed.confidence)) parsed.confidence = "low";
        } catch (e) {
          parsingErrors.push({ email, error: e.message, preview: text.slice(0, 400) });
          parsed = {
            status: "no messages found",
            lastCheckinDate: null,
            evidence: `JSON parsing failed. Preview: ${text.slice(0, 200)}...`,
            confidence: "low",
          };
        }

        results.push({
          email,
          status: parsed.status,
          lastCheckinDate: parsed.lastCheckinDate,
          evidence: parsed.evidence,
          confidence: parsed.confidence,
        });

      } catch (err) {
        results.push({
          email,
          status: "no messages found",
          lastCheckinDate: null,
          evidence: "Error processing thread",
          confidence: "low",
          error: err?.message || String(err),
        });
      }
    }

    // convenience maps/exports
    const byEmail = Object.fromEntries(results.map(r => [r.email, {
      status: r.status,
      lastCheckinDate: r.lastCheckinDate,
      evidence: r.evidence,
      confidence: r.confidence,
      ...(r.error ? { error: r.error } : {}),
    }]));

    if (parsingErrors.length) $.export("parsingErrors", parsingErrors);
    $.export("contacts", results);
    $.export("byEmail", byEmail);

    const successful = results.filter(r => !r.error && !(r.evidence || "").startsWith("JSON parsing failed")).length;
    const failed = results.length - successful;
    $.export("$summary", `Analyzed ${results.length} contacts • ${successful} OK • ${failed} failed • ${parsingErrors.length} JSON errors`);

    return {
      contacts: results,       // list
      byEmail,                 // map
      statusBreakdown: {
        signUpNow: results.filter(r => r.status === "said they would sign up or pay now").length,
        signUpLater: results.filter(r => r.status === "said they would sign up or pay at a later date").length,
        interested: results.filter(r => r.status === "said they were interested").length,
        notInterested: results.filter(r => r.status === "not interested or doubtful").length,
        noMessages: results.filter(r => r.status === "no messages found").length,
      },
      totals: {
        contacts: results.length,
        successful,
        failed,
        jsonParsingErrors: parsingErrors.length,
      },
    };
  },
});
