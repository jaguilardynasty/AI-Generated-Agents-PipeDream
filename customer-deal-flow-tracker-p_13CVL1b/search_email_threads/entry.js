import { axios } from "@pipedream/platform";

export default defineComponent({
  name: "Search Gmail by Multiple Email Addresses (FULL Threads)",
  description: "Search Gmail for threads where an email appears in From/To/Cc/Bcc and return full message bodies (plain + HTML), oldest → newest.",
  type: "action",
  props: {
    // Use Pipedream's Gmail app auth for OAuth token
    gmail: {
      type: "app",
      app: "gmail",
      label: "Gmail account",
    },
    emailAddresses: {
      type: "string[]",
      label: "Email Addresses",
      description: "Array of email addresses to search for in Gmail",
    },
    includeTestEmail: {
      type: "boolean",
      label: "Include test email kevin@superpower.com",
      default: false,
      optional: true,
    },
    searchDays: {
      type: "integer",
      label: "Look-back window (days)",
      default: 120,
      optional: true,
    },
    maxThreadsPerEmail: {
      type: "integer",
      label: "Max threads per email",
      default: 50,
      optional: true,
    },
    maxPagesPerEmail: {
      type: "integer",
      label: "Max pages per email",
      default: 3,
      optional: true,
    },
    extraQuery: {
      type: "string",
      label: "Extra Gmail query (optional)",
      description: "e.g. -in:chats -category:social -label:spam -label:trash",
      optional: true,
    },
    concurrency: {
      type: "integer",
      label: "Parallel thread fetches",
      default: 5,
      optional: true,
    },
  },

  async run({ $ }) {
    /* -------- gather emails (and optional test email) -------- */
    const emails = new Set((this.emailAddresses || []).map(e => String(e).trim().toLowerCase()));
    if (this.includeTestEmail) emails.add("kevin@superpower.com");

    if (!emails.size) {
      $.export("$summary", "No email addresses provided");
      return { error: "No email addresses provided", resultsByEmail: {}, uniqueThreads: 0, threads: [] };
    }

    /* -------- setup -------- */
    const token = this.gmail.$auth.oauth_access_token;
    const base = "https://gmail.googleapis.com/gmail/v1/users/me";
    const headers = { Authorization: `Bearer ${token}` };

    const newer = this.searchDays ? ` newer_than:${this.searchDays}d` : "";
    const extra = this.extraQuery ? ` ${this.extraQuery}` : "";

    // List threads for a query with paging/caps
    const listThreadsForQuery = async (q, maxThreads, maxPages) => {
      let pageToken;
      const collected = [];
      for (let page = 0; page < maxPages; page++) {
        const resp = await axios($, {
          method: "GET",
          url: `${base}/threads`,
          headers,
          params: {
            q,
            maxResults: Math.min(100, Math.max(1, maxThreads - collected.length)),
            pageToken,
          },
        });
        const threads = resp?.threads || [];
        collected.push(...threads);
        pageToken = resp?.nextPageToken;
        if (!pageToken || collected.length >= maxThreads) break;
      }
      return collected.slice(0, maxThreads);
    };

    // base64url → utf8
    const b64urlToUtf8 = (data) => {
      if (!data) return "";
      const norm = data.replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (norm.length % 4)) % 4);
      return Buffer.from(norm + pad, "base64").toString("utf8");
    };

    // Extract text/plain + text/html recursively from a message payload
    const extractBodies = (payload) => {
      const acc = { plain: [], html: [] };
      const walk = (p) => {
        if (!p) return;
        const mt = (p.mimeType || "").toLowerCase();
        if (p.body?.data && (mt === "text/plain" || mt === "text/html")) {
          const text = b64urlToUtf8(p.body.data);
          if (mt === "text/plain") acc.plain.push(text);
          else acc.html.push(text);
        }
        if (Array.isArray(p.parts)) p.parts.forEach(walk);
      };
      walk(payload);
      return {
        plainBody: acc.plain.join("\n\n"),
        htmlBody: acc.html.join("\n\n"),
      };
    };

    const getHeader = (headersArr, name) =>
      headersArr?.find(h => (h.name || "").toLowerCase() === name)?.value || "";

    // Fetch a thread with full message bodies, sorted oldest → newest
    const fetchThreadFull = async (threadId) => {
      const resp = await axios($, {
        method: "GET",
        url: `${base}/threads/${threadId}`,
        headers,
        params: { format: "full" }, // FULL bodies
      });
      const th = resp || {};
      const messages = Array.isArray(th.messages) ? th.messages : [];
      messages.sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));

      const msgs = messages.map(m => {
        const headersArr = m.payload?.headers || [];
        const subject = getHeader(headersArr, "subject") || "(no subject)";
        const from = getHeader(headersArr, "from");
        const to = getHeader(headersArr, "to");
        const cc = getHeader(headersArr, "cc");
        const bcc = getHeader(headersArr, "bcc");
        const date = getHeader(headersArr, "date");
        const bodies = extractBodies(m.payload || {});
        return {
          id: m.id,
          threadId: m.threadId,
          internalDate: m.internalDate,   // ms as string
          date,                            // header Date
          subject, from, to, cc, bcc,
          snippet: m.snippet || "",
          plainBody: bodies.plainBody,
          htmlBody: bodies.htmlBody,
        };
      });

      return {
        threadId: th.id,
        historyId: th.historyId,
        threadUrl: `https://mail.google.com/mail/u/0/#all/${th.id}`,
        messageCount: msgs.length,
        messages: msgs,
      };
    };

    // Simple concurrency pool
    const runPool = async (tasks, size) => {
      const executing = new Set();
      for (const task of tasks) {
        const p = task().finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= size) await Promise.race(executing);
      }
      await Promise.allSettled(executing);
    };

    /* -------- search per email → collect unique thread IDs -------- */
    const perEmailThreadIds = new Map();
    const globalThreadIds = new Set();

    for (const email of emails) {
      const q = `in:anywhere (${["from", "to", "cc", "bcc"].map(f => `${f}:${email}`).join(" OR ")})${newer}${extra}`;
      const threads = await listThreadsForQuery(q, this.maxThreadsPerEmail, this.maxPagesPerEmail);
      const setForEmail = new Set();
      for (const t of threads) {
        if (!t?.id) continue;
        setForEmail.add(t.id);
        globalThreadIds.add(t.id);
      }
      perEmailThreadIds.set(email, setForEmail);
    }

    /* -------- fetch each unique thread (FULL) once -------- */
    const threadIds = Array.from(globalThreadIds);
    const threadsById = new Map();

    const tasks = threadIds.map(id => async () => {
      try {
        const full = await fetchThreadFull(id);
        threadsById.set(id, full);
      } catch (e) {
        threadsById.set(id, { threadId: id, error: e.message });
      }
    });

    await runPool(tasks, Math.max(1, this.concurrency || 5));

    /* -------- assemble output -------- */
    const resultsByEmail = {};
    for (const email of emails) {
      const ids = perEmailThreadIds.get(email) || new Set();
      resultsByEmail[email] = {
        countThreads: ids.size,
        query: `in:anywhere (${["from","to","cc","bcc"].map(f=>`${f}:${email}`).join(" OR ")})${newer}${extra}`,
        threads: Array.from(ids).map(id => threadsById.get(id)).filter(Boolean),
      };
    }

    const threads = Array.from(new Set([].concat(...Object.values(resultsByEmail).map(v => v.threads))));

    $.export("$summary", `Fetched ${threads.length} full thread(s) across ${emails.size} email(s)`);

    return {
      resultsByEmail,            // per-email grouping
      uniqueThreads: threads.length,
      threads,                   // all full threads (messages include plainBody/htmlBody)
    };
  },
});
