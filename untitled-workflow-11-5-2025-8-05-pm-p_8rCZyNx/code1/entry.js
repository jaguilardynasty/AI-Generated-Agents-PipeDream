import { axios } from "@pipedream/platform";

export default defineComponent({
  props: {
    // Connected apps
    google_sheets: { type: "app", app: "google_sheets" },
    hubspot:       { type: "app", app: "hubspot" },

    // Where to read [Name, Email, Phone] rows from the Tally step
    valuesPath: {
      type: "string",
      label: "Path to partial rows",
      description: "Example: steps.fetch_partials.$return_value.values",
      default: "steps.fetch_partials.$return_value.values",
    },
    // Extra candidates to try if valuesPath doesn't resolve
    altValuesPaths: {
      type: "string[]",
      label: "Alternate paths (optional)",
      description: "Tried in order if valuesPath fails. Examples: steps.fetch_partials.values, steps.fetch_partials.$return_value",
      default: [],
      optional: true,
    },

    // Create a new sheet or write to existing
    createMode: {
      type: "string",
      label: "Where to write results",
      default: "new",
      options: ["new", "existing"],
    },

    // For NEW
    spreadsheetTitle: {
      type: "string",
      label: "New spreadsheet title",
      description: "If left as default, will append today's date at runtime",
      default: "Not in HubSpot - Partials",
      optional: true,
    },

    // For EXISTING
    spreadsheetId: {
      type: "string",
      label: "Existing Spreadsheet ID",
      optional: true,
    },
    spreadsheetUrl: {
      type: "string",
      label: "Existing Spreadsheet URL (optional)",
      optional: true,
    },

    // Sheet/tab name (both modes)
    sheetTitle: {
      type: "string",
      label: "Worksheet (tab) name",
      default: "Partial Submissions - Not in HubSpot",
    },

    // Formatting / behavior
    writeHeader: {
      type: "boolean",
      label: "Write header row if sheet is new/empty",
      default: true,
      optional: true,
    },
    headerLabels: {
      type: "string[]",
      label: "Header labels (3 columns)",
      default: ["Name", "Email", "Phone"],
      optional: true,
    },
    valueInputOption: {
      type: "string",
      label: "Value input option",
      default: "RAW",
      options: ["RAW", "USER_ENTERED"],
    },
    dedupeWithinRun: {
      type: "boolean",
      label: "De-duplicate emails within this run before writing",
      default: true,
      optional: true,
    },
    hubspotBatchSize: {
      type: "integer",
      label: "HubSpot batch size (max 100)",
      default: 100,
      optional: true,
    },
  },

  async run({ $, steps }) {
    // ---------- Robust resolver for values ----------
    const getByPath = (root, path) => {
      try {
        return path.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), root);
      } catch { return undefined; }
    };

    const tryPaths = [
      this.valuesPath,
      ...((this.altValuesPaths || []).filter(Boolean)),
      // helpful auto-fallbacks:
      // swap $return_value vs values, since users often have one or the other
      this.valuesPath.replace(".$return_value.values", ".values"),
      this.valuesPath.replace(".values", ".$return_value.values"),
      this.valuesPath.replace(".values", ".$return_value"),
    ].filter((p, idx, arr) => p && arr.indexOf(p) === idx);

    let resolved = undefined;
    let resolvedFrom = null;
    for (const p of tryPaths) {
      const candidate = getByPath({ steps }, p);
      if (candidate !== undefined) {
        resolved = candidate;
        resolvedFrom = p;
        break;
      }
    }

    // Normalize to a 2D array [[Name, Email, Phone], ...]
    const to2D = (val) => {
      if (Array.isArray(val) && Array.isArray(val[0])) return val;            // already 2D
      if (Array.isArray(val) && val.length && !Array.isArray(val[0])) return [val]; // single row
      if (val && typeof val === "object" && Array.isArray(val.values)) return to2D(val.values);
      return null;
    };

    const rows2D = to2D(resolved);

    if (!rows2D) {
      return {
        message: "Resolved 'values' is not an array (or 2D array).",
        hint: "Update valuesPath / altValuesPaths to point at [[Name, Email, Phone], ...].",
        triedPaths: tryPaths,
        typeofResolved: typeof resolved,
        sampleResolved: (resolved && JSON.stringify(resolved).slice(0, 400)) || null,
        didWrite: false,
      };
    }

    // ---------- Validate/normalize rows ----------
    const normalized = rows2D
      .map(r => Array.isArray(r) ? r : [])
      .filter(r => r.length >= 2) // at least Name & Email
      .map(([name, email, phone]) => ({
        name: (name ?? "").toString().trim(),
        email: (email ?? "").toString().trim().toLowerCase(),
        phone: (phone ?? "").toString().trim(),
      }))
      .filter(r => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(r.email));

    if (!normalized.length) {
      return {
        message: "No valid rows/emails after normalization.",
        resolvedFrom,
        sampleInput: rows2D.slice(0, 5),
        didWrite: false,
      };
    }

    // (Optional) dedupe within run
    const seen = new Set();
    const filtered = this.dedupeWithinRun
      ? normalized.filter(r => !seen.has(r.email) && seen.add(r.email))
      : normalized;

    // ---------- HubSpot check ----------
    const hsToken =
      this.hubspot?.$auth?.oauth_access_token ||
      this.hubspot?.$auth?.api_key ||
      this.hubspot?.$auth?.token;
    if (!hsToken) throw new Error("Missing HubSpot auth.");

    const uniqueEmails = [...new Set(filtered.map(r => r.email))];
    const found = new Set();
    const chunkSize = Math.min(Math.max(this.hubspotBatchSize || 100, 1), 100);

    const chunk = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    for (const grp of chunk(uniqueEmails, chunkSize)) {
      const res = await axios($, {
        method: "POST",
        url: "https://api.hubapi.com/crm/v3/objects/contacts/batch/read?archived=false",
        headers: {
          Authorization: `Bearer ${hsToken}`,
          "Content-Type": "application/json",
        },
        data: {
          idProperty: "email",
          properties: ["email"],
          inputs: grp.map(e => ({ id: e })),
        },
        validateStatus: () => true,
      });
      if (res?.status >= 400) throw new Error(`HubSpot batch read error ${res.status}: ${JSON.stringify(res)}`);
      for (const r of (res?.results || [])) {
        const e = r?.properties?.email;
        if (e) found.add(String(e).toLowerCase());
      }
      await new Promise(r => setTimeout(r, 150));
    }

    const notFoundRows = filtered.filter(r => !found.has(r.email)).map(r => [r.name, r.email, r.phone]);

    if (!notFoundRows.length) {
      return {
        message: `Checked ${uniqueEmails.length} unique email(s) — all exist in HubSpot.`,
        resolvedFrom,
        didWrite: false,
      };
    }

    // ---------- Google Sheets write (new or existing) ----------
    const gsToken =
      this.google_sheets?.$auth?.oauth_access_token ||
      this.google_sheets?.$auth?.access_token;
    if (!gsToken) throw new Error("Missing Google Sheets auth.");

    let spreadsheetId = null;
    let spreadsheetUrl = null;

    if (this.createMode === "new") {
      let title = (this.spreadsheetTitle || "").trim();
      if (!title || title === "Not in HubSpot - Partials") {
        const ymd = new Date().toISOString().slice(0, 10);
        title = `Not in HubSpot - Partials ${ymd}`;
      }
      const createRes = await axios($, {
        method: "POST",
        url: "https://sheets.googleapis.com/v4/spreadsheets",
        headers: {
          Authorization: `Bearer ${gsToken}`,
          "Content-Type": "application/json",
        },
        data: {
          properties: { title },
          sheets: [{ properties: { title: this.sheetTitle } }],
        },
      });
      spreadsheetId = createRes?.spreadsheetId;
      spreadsheetUrl = createRes?.spreadsheetUrl;
      if (!spreadsheetId) throw new Error("Failed to create spreadsheet.");
    } else {
      spreadsheetId = this.spreadsheetId;
      if (!spreadsheetId && this.spreadsheetUrl) {
        const m = this.spreadsheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
        if (!m) throw new Error("Could not parse spreadsheetId from spreadsheetUrl.");
        spreadsheetId = m[1];
      }
      if (!spreadsheetId) throw new Error("Provide spreadsheetId or spreadsheetUrl for existing mode.");

      // ensure tab exists
      const meta = await axios($, {
        method: "GET",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(title))`,
        headers: { Authorization: `Bearer ${gsToken}` },
      });
      const titles = (meta?.sheets || []).map(s => s?.properties?.title);
      if (!titles.includes(this.sheetTitle)) {
        await axios($, {
          method: "POST",
          url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
          headers: {
            Authorization: `Bearer ${gsToken}`,
            "Content-Type": "application/json",
          },
          data: { requests: [{ addSheet: { properties: { title: this.sheetTitle } } }] },
        });
      }
    }

    // header
    if (this.writeHeader) {
      const header = Array.isArray(this.headerLabels) && this.headerLabels.length === 3
        ? this.headerLabels
        : ["Name", "Email", "Phone"];
      await axios($, {
        method: "POST",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${this.sheetTitle}!A1:C1`)}:append`,
        params: { valueInputOption: this.valueInputOption || "RAW", insertDataOption: "INSERT_ROWS" },
        headers: { Authorization: `Bearer ${gsToken}`, "Content-Type": "application/json" },
        data: { values: [header] },
        validateStatus: () => true,
      });
    }

    // rows
    const appendRes = await axios($, {
      method: "POST",
      url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${this.sheetTitle}!A:C`)}:append`,
      params: { valueInputOption: this.valueInputOption || "RAW", insertDataOption: "INSERT_ROWS" },
      headers: { Authorization: `Bearer ${gsToken}`, "Content-Type": "application/json" },
      data: { values: notFoundRows },
      validateStatus: () => true,
    });

    const updatedRows = appendRes?.updates?.updatedRows ?? notFoundRows.length;

    return {
      message: `${this.createMode === "new" ? "Created" : "Updated"} sheet and wrote ${updatedRows} not-found row(s).`,
      resolvedFrom,
      createMode: this.createMode,
      spreadsheetId,
      spreadsheetUrl,
      sheetTitle: this.sheetTitle,
      wrote: updatedRows,
      preview: notFoundRows.slice(0, 10),
    };
  },
});
