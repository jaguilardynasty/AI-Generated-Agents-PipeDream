import slack from "@pipedream/slack";

export default defineComponent({
  name: "Send Categorized Contact Status Results",
  description:
    "Groups AI-analyzed contacts by status, sorts by last check-in (desc), and posts a formatted message to Slack",
  type: "action",
  props: {
    slack,
    channel: { propDefinition: [slack, "conversation"] },
    analysisResults: {
      type: "any",
      label: "Analysis Results",
      description:
        "Select the FULL return value from your analyzer step, e.g. {{ steps.analyze_email_threads.$return_value }}",
    },
  },

  async run({ $ }) {
    // ---------- helpers ----------
    const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());
    const toISO = (d) => {
      if (!d) return null;
      const t = new Date(d);
      return isNaN(t) ? null : t.toISOString().slice(0, 10); // YYYY-MM-DD
    };
    const toCmp = (d) => {
      const t = new Date(d);
      return isNaN(t) ? new Date(0) : t;
    };

    // Chunk long mrkdwn into multiple sections under Slack limits
    function sectionBlocksFromLines(lines) {
      const MAX = 2800; // 3,000 is Slack hard limit, keep headroom
      const out = [];
      let buf = "";
      for (const line of lines) {
        const add = (buf ? "\n\n" : "") + line;
        if ((buf + add).length > MAX) {
          if (buf) out.push({ type: "section", text: { type: "mrkdwn", text: buf } });
          buf = line; // start new chunk
        } else {
          buf += add;
        }
      }
      if (buf) out.push({ type: "section", text: { type: "mrkdwn", text: buf } });
      return out;
    }

    // ---------- input ----------
    const contactsIn = Array.isArray(this.analysisResults?.contacts)
      ? this.analysisResults.contacts
      : [];

    // Quick debug so you can see what arrived
    $.export("contacts_count_in", contactsIn.length);
    $.export("status_sample", contactsIn.slice(0, 5).map((c) => c?.status));

    // ---------- normalize ----------
    const normalized = contactsIn.map((c) => ({
      email: c?.email || "",
      name: c?.name || c?.email || "",
      statusRaw: norm(c?.status),
      dateISO: toISO(c?.lastCheckinDate || c?.lastContactedDate || null),
    }));

    // ---------- mapping to your 3 display categories ----------
    const MAP = {
      "said they would sign up or pay now":
        "Said they would sign up now (but haven't)",
      "said they would sign up or pay at a later date":
        "Said they would sign up in the future",
      "said they were interested": "Said they were interested",
    };

    const CATEGORIES = [
      "Said they would sign up now (but haven't)",
      "Said they would sign up in the future",
      "Said they were interested",
    ];

    // Init groups
    const groups = {};
    CATEGORIES.forEach((cat) => (groups[cat] = []));

    // Bucket contacts; ignore other statuses for this message
    normalized.forEach((c) => {
      const mapped =
        MAP[c.statusRaw] ||
        CATEGORIES.find((cat) => cat.toLowerCase() === c.statusRaw) ||
        null;
      if (mapped) groups[mapped].push(c);
    });

    // Sort each group by date desc (unknown dates go last)
    Object.keys(groups).forEach((cat) => {
      groups[cat].sort((a, b) => {
        const da = a.dateISO ? toCmp(a.dateISO) : new Date(0);
        const db = b.dateISO ? toCmp(b.dateISO) : new Date(0);
        return db - da; // desc
      });
    });

    // ---------- build Slack blocks (DO NOT stringify) ----------
    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "📊 Contact Status Results" },
      },
    ];

    let anyShown = false;

    const addCategory = (label) => {
      const list = groups[label] || [];
      if (!list.length) return;

      anyShown = true;

      // Category header with count
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${label}* (${list.length} contact${list.length > 1 ? "s" : ""})`,
        },
      });

      // Lines for this category
      const lines = list.map((c) => {
        const when = c.dateISO || "Unknown";
        return `• *${c.name}* - ${c.email}\n  _Last contacted: ${when}_`;
      });

      // Chunk into multiple sections if needed
      blocks.push(...sectionBlocksFromLines(lines));

      // Divider
      blocks.push({ type: "divider" });
    };

    CATEGORIES.forEach(addCategory);

    // Remove trailing divider
    if (blocks[blocks.length - 1]?.type === "divider") blocks.pop();

    if (!anyShown) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "_No contacts matched the three display categories. " +
            "Check analyzer output or broaden categories._",
        },
      });
    }

    const totalShown = normalized.filter(
      (n) => MAP[n.statusRaw] || CATEGORIES.some((c) => c.toLowerCase() === n.statusRaw)
    ).length;

    // Footer
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Total contacts shown: ${totalShown} | Generated on ${new Date().toLocaleDateString()}`,
        },
      ],
    });

    // Safety: cap to Slack's 50-block limit
    if (blocks.length > 50) {
      $.export("blocks_truncated_from", blocks.length);
      blocks.splice(50);
    }

    // ---------- send (pass blocks ARRAY, not string) ----------
    const resp = await this.slack.postChatMessage({
      channel: this.channel,
      text: `Contact Status Results - ${totalShown} contacts categorized`,
      blocks, // <-- array, not JSON.stringify(blocks)
    });

    $.export("$summary", `Posted summary for ${totalShown} contacts`);
    return resp;
  },
});
