import { axios } from "@pipedream/platform";

export default defineComponent({
  props: {
    tally: { type: "app", app: "tally" },
    formId: {
      type: "string",
      label: "Tally Form ID",
      description: "Short ID from the URL, e.g. wAO5j0",
    },
    // Map your Tally question_* keys → Name/Email/Phone
    nameKey: {
      type: "string",
      default: "question_OXXjxk",
      label: "Name question key",
    },
    emailKey: {
      type: "string",
      default: "question_GppoOQ",
      label: "Email question key",
    },
    phoneKey: {
      type: "string",
      default: "question_VPP9WN",
      label: "Phone question key",
    },
    maxPages: {
      type: "integer",
      label: "Max pages to fetch",
      default: 5,
      optional: true,
    },
  },
  async run({ $ }) {
    const TOKEN =
      this.tally?.$auth?.api_key ||
      this.tally?.$auth?.token ||
      this.tally?.$auth?.oauth_access_token;
    if (!TOKEN) throw new Error("Missing Tally auth. Connect with an API key if possible.");

    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
    const baseUrl = `https://api.tally.so/forms/${this.formId}/submissions`;

    // unify API shapes:
    const extractSubs = (res) => {
      if (!res) return { items: [], hasMore: false };
      if (Array.isArray(res)) return { items: res, hasMore: false };
      if (Array.isArray(res.submissions)) return { items: res.submissions, hasMore: !!res.hasMore };
      if (Array.isArray(res.data)) return { items: res.data, hasMore: !!res.hasMore };
      return { items: [], hasMore: false };
    };

    const clean = (v) => {
      if (Array.isArray(v)) return v.join("; ");
      if (v == null) return "";
      return String(v).trim();
    };

    // de-dupe by submission id across runs
    const seen = new Set(this.db?.seenIds || []);
    const newIds = [];
    const rows = [];

    let page = 1;
    let keepGoing = true;
    let fetched = 0;

    while (page <= this.maxPages && keepGoing) {
      const res = await axios($, {
        url: baseUrl,
        headers,
        params: { page, filter: "partial" },
        validateStatus: () => true,
      });

      const { items, hasMore } = extractSubs(res);
      if (!items.length) break;

      for (const item of items) {
        const id = item.id || item.submissionId || item.responseId;
        if (!id || seen.has(id)) continue;

        const name = clean(item[this.nameKey]);
        const email = clean(item[this.emailKey]);
        const phone = clean(item[this.phoneKey]);

        // push exactly 3 columns: Name | Email | Phone
        rows.push([name, email, phone]);

        newIds.push(id);
        fetched++;
      }

      keepGoing = !!hasMore;
      page++;
    }

    // persist de-dupe cache
    this.db = { seenIds: [...newIds, ...seen].slice(0, 5000) };

    return {
      message: `Fetched ${fetched} partial submissions (mapped to Name/Email/Phone)`,
      formId: this.formId,
      values: rows,          // ← use this in Google Sheets "Append Values"
      preview: rows.slice(0, 5),
      mappedKeys: {
        nameKey: this.nameKey,
        emailKey: this.emailKey,
        phoneKey: this.phoneKey,
      },
    };
  },
});
