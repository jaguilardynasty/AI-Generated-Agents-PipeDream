import OpenAI from "openai";
import openai from "@pipedream/openai";

export default defineComponent({
  name: "Find Follow-Up Requests with Dates (Clean JSON) — Your OpenAI Connected Account",
  description:
    "Extracts follow-up requests, returning the quote, the message date, and a derived follow-up date. Excludes any messages from Alessandro or @getdynasty.com.",
  type: "action",
  props: {
    openai,
    emailThreads: {
      type: "any",
      label: "Email Threads",
      description:
        "Object keyed by email (use steps.search_email_threads.$return_value.resultsByEmail)",
    },
    model: {
      type: "string",
      label: "OpenAI Model",
      options: ["gpt-4o", "gpt-4o-mini"],
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

    const client = new OpenAI({
      apiKey: this.openai.$auth.api_key,
    });

    const SYSTEM = `You analyze email conversations to find when the CONTACT (not anyone at GetDynasty) asked for a follow-up, or said that they would check back in.
    You are only grabbing the most recent evidence of this.

CRITICAL:
- Respond with VALID JSON ONLY. No prose, no code fences.
- Consider ONLY messages from the other party (exclude *@getdynasty.com).
- ALSO EXCLUDE any message from senders containing "alessandro" (case-insensitive), including alessandro@getdynasty.com.
- Extract exact quotes where the contact indicates they want a follow-up later.

For each qualifying message:
- "messageDate": timestamp of the message (YYYY-MM-DD HH:MM:SS).
- "quote": exact substring from the message indicating follow-up timing.
- "followUpDate": the normalized calendar date (YYYY-MM-DD) when the follow-up should occur.  
  • Example: If a message was sent on 2025-08-10 and said "follow up in November", then followUpDate = 2025-11-01.  
  • If they say "next week" on 2025-08-10, followUpDate = 2025-08-17.  
  • Always pick the earliest reasonable day in the specified timeframe (start of the week/month/quarter, or the exact day if given).

Return EXACTLY:
{
  "followUps": [
    { "messageDate": "YYYY-MM-DD HH:MM:SS", "quote": "string", "followUpDate": "YYYY-MM-DD" }
  ],
  "confidence": "high" | "medium" | "low"
}`;

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

    const isValidContactSender = (from = "") => {
      const f = String(from).toLowerCase();
      if (!f) return false;
      if (f.includes("@getdynasty.com")) return false;
      if (f.includes("alessandro")) return false;
      return true;
    };

    const collectContactMessages = (value) => {
      const out = [];
      if (Array.isArray(value?.threads)) {
        for (const t of value.threads) {
          for (const m of t?.messages || []) {
            if (isValidContactSender(m?.from)) {
              out.push({
                date: m.date || m.internalDate || "",
                from: m.from || "",
                body: stripHtml(m.plainBody || m.htmlBody || m.snippet || ""),
              });
            }
          }
        }
      }
      if (Array.isArray(value?.messages)) {
        for (const m of value.messages) {
          if (isValidContactSender(m?.from)) {
            out.push({
              date: m.date || m.internalDate || "",
              from: m.from || "",
              body: stripHtml(m.plainBody || m.htmlBody || m.snippet || ""),
            });
          }
        }
      }
      out.sort(
        (a, b) =>
          (Date.parse(a.date || "") || 0) -
          (Date.parse(b.date || "") || 0)
      );
      return out.slice(Math.max(0, out.length - MAX_MSGS));
    };

    const toTranscript = (msgs) =>
      msgs
        .map((m) => {
          const d = Date.parse(m.date || "");
          const iso = isNaN(d)
            ? "unknown"
            : new Date(d).toISOString().replace("T", " ").slice(0, 19);
          return `[${iso}] ${m.from}: ${m.body}`;
        })
        .join("\n")
        .slice(-MAX_CHARS);

    const results = [];
    const parsingErrors = [];

    for (const email of Object.keys(threadsByEmail)) {
      const raw = threadsByEmail[email];
      try {
        const msgs = collectContactMessages(raw);
        const transcript = toTranscript(msgs);

        const userContent = `Extract follow-up requests for ${email}.\n\nTHREAD:\n${transcript}`;

        let resp;
        try {
          resp = await client.chat.completions.create({
            model: this.model,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 700,
          });
        } catch (e) {
          resp = await client.responses.create({
            model: this.model,
            input: [
              { role: "system", content: SYSTEM },
              { role: "user", content: userContent },
            ],
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_output_tokens: 700,
          });
        }

        let text =
          resp?.choices?.[0]?.message?.content ??
          resp?.output_text ??
          "";
        text = String(text).trim();
        if (text.startsWith("```")) {
          text = text
            .replace(/^```(?:json)?/i, "")
            .replace(/```$/, "")
            .trim();
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
          if (!Array.isArray(parsed.followUps)) parsed.followUps = [];
          if (!["high", "medium", "low"].includes(parsed.confidence))
            parsed.confidence = parsed.followUps.length ? "medium" : "low";
        } catch (e) {
          parsingErrors.push({ email, error: e.message, preview: text });
          parsed = {
            followUps: [],
            lastFollowUpIntentDate: null,
            confidence: "low",
          };
        }

        results.push({
          email,
          followUps: parsed.followUps,
          lastFollowUpIntentDate: parsed.lastFollowUpIntentDate,
          confidence: parsed.confidence,
        });
      } catch (err) {
        results.push({
          email,
          followUps: [],
          lastFollowUpIntentDate: null,
          confidence: "low",
          error: err?.message || String(err),
        });
      }
    }

    const byEmail = Object.fromEntries(
      results.map((r) => [
        r.email,
        {
          followUps: r.followUps,
          lastFollowUpIntentDate: r.lastFollowUpIntentDate,
          confidence: r.confidence,
          ...(r.error ? { error: r.error } : {}),
        },
      ])
    );

    if (parsingErrors.length) $.export("parsingErrors", parsingErrors);
    $.export("contacts", results);
    $.export("byEmail", byEmail);

    return {
      contacts: results,
      byEmail,
    };
  },
});
