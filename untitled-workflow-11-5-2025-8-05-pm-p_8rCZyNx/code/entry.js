import { axios } from "@pipedream/platform";

export default defineComponent({
  props: {
    google_sheets: { type: "app", app: "google_sheets" },
    hubspot:       { type: "app", app: "hubspot" },

    // Provide either spreadsheetId or the full spreadsheetUrl:
    spreadsheetId: {
      type: "string",
      label: "Spreadsheet ID",
      description: "From the URL: docs.google.com/spreadsheets/d/<THIS>",
      optional: true,
    },
    spreadsheetUrl: {
      type: "string",
      label: "Spreadsheet URL (optional)",
      description: "Paste the full Google Sheets URL if you prefer.",
      optional: true,
    },

    sheetName: {
      type: "string",
      label: "Worksheet (tab) name",
      default: "Contacts",
    },
    headerRow: {
      type: "integer",
      label: "Header row number",
      description: "Row number containing the 'Email' header. Data starts after this row.",
      default: 1,
      optional: true,
    },
    emailColumn: {
      type: "string",
      label: "Email column letter",
      description: "Column that contains emails (e.g., B).",
      default: "B",
    },
    maxRows: {
      type: "integer",
      label: "Max rows to read (0 = all)",
      default: 0,
      optional: true,
    },
    chunkSize: {
      type: "integer",
      label: "HubSpot batch size",
      description: "HubSpot supports up to 100 inputs per batch read.",
      default: 100,
      optional: true,
    },
    // Name of the destination tab for NOT-found emails:
    notFoundTabName: {
      type: "string",
      label: "Destination tab for not-found emails",
      default: "Has not booked a call",
    },
    // If we create the destination tab, write a header first?
    writeHeaderIfNew: {
      type: "boolean",
      label: "Write header 'Email' if the tab is created",
      default: true,
      optional: true,
    },
    valueInputOption: {
      type: "string",
      label: "Value Input Option",
      description: "RAW leaves data as-is; USER_ENTERED lets Sheets format it",
      default: "RAW",
      optional: true,
      options: ["RAW", "USER_ENTERED"],
    },
  },

  async run({ $, steps }) {
    // -------- Google Sheets auth + spreadsheet ID --------
    const gsToken =
      this.google_sheets?.$auth?.oauth_access_token ||
      this.google_sheets?.$auth?.access_token;
    if (!gsToken) throw new Error("Missing Google Sheets OAuth token. Reconnect Google Sheets.");

    let spreadsheetId = this.spreadsheetId;
    if (!spreadsheetId && this.spreadsheetUrl) {
      const m = this.spreadsheetUrl.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!m) throw new Error("Could not parse spreadsheetId from spreadsheetUrl.");
      spreadsheetId = m[1];
    }
    if (!spreadsheetId) throw new Error("Provide spreadsheetId or spreadsheetUrl.");

    // -------- Read Column B (“Email”) from the sheet --------
    const range = `${this.sheetName}!${this.emailColumn}:${this.emailColumn}`; // e.g. Contacts!B:B
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(range)}`;

    const getRes = await axios($, {
      method: "GET",
      url: getUrl,
      headers: { Authorization: `Bearer ${gsToken}` },
      params: { majorDimension: "COLUMNS" },
      validateStatus: () => true,
    });

    const col = Array.isArray(getRes?.values) && Array.isArray(getRes.values[0])
      ? getRes.values[0]
      : [];

    // Drop header row(s) and limit rows if requested
    const dataStartIdx = Math.max((this.headerRow || 1), 1); // 1-based header → slice index
    const emailsRaw = col.slice(dataStartIdx); // remove header row
    const limited = this.maxRows > 0 ? emailsRaw.slice(0, this.maxRows) : emailsRaw;

    // Normalize + validate emails
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
    const emails = [...new Set(
      limited
        .map(v => (v ?? "").toString().trim().toLowerCase())
        .filter(v => v && emailRegex.test(v))
    )];

    if (emails.length === 0) {
      return {
        message: "No valid emails found in the specified column/range.",
        sheetName: this.sheetName,
        emailColumn: this.emailColumn,
        headerRow: this.headerRow,
        readCount: limited.length,
        validEmails: 0,
        existingCount: 0,
        missingCount: 0,
        writtenToTab: null,
      };
    }

    // -------- HubSpot auth --------
    const hsToken =
      this.hubspot?.$auth?.oauth_access_token ||
      this.hubspot?.$auth?.api_key ||    // Private App token often appears here
      this.hubspot?.$auth?.token;
    if (!hsToken) throw new Error("Missing HubSpot auth. Connect HubSpot (Private App token preferred).");

    const hsUrl = "https://api.hubapi.com/crm/v3/objects/contacts/batch/read?archived=false";
    const chunkSize = Math.min(Math.max(this.chunkSize || 100, 1), 100);

    const chunk = (arr, size) => {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };

    // -------- Batch read by email --------
    const found = new Set();
    for (const group of chunk(emails, chunkSize)) {
      const body = {
        idProperty: "email",
        properties: ["email", "firstname", "lastname", "hs_object_id"],
        inputs: group.map(e => ({ id: e })),
      };

      const res = await axios($, {
        method: "POST",
        url: hsUrl,
        headers: {
          Authorization: `Bearer ${hsToken}`,
          "Content-Type": "application/json",
        },
        data: body,
        validateStatus: () => true,
      });

      if (res?.status >= 400) {
        throw new Error(`HubSpot batch read error ${res.status}: ${JSON.stringify(res)}`);
      }

      const results = Array.isArray(res?.results) ? res.results : [];
      for (const r of results) {
        const e = r?.properties?.email;
        if (e) found.add(String(e).toLowerCase());
      }

      // Be gentle with rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    const existingEmails = emails.filter(e => found.has(e));
    const missingEmails  = emails.filter(e => !found.has(e));

    // ---------- WRITE missing emails to "Has not booked a call" ----------
    const targetTab = this.notFoundTabName || "Has not booked a call";

    // Ensure the target tab exists (create if missing)
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=sheets(properties(title))`;

    const meta = await axios($, {
      method: "GET",
      url: metaUrl,
      headers: { Authorization: `Bearer ${gsToken}` },
    });

    const titles = (meta?.sheets || []).map(s => s?.properties?.title);
    const exists = titles.includes(targetTab);

    if (!exists) {
      const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`;

      await axios($, {
        method: "POST",
        url: batchUrl,
        headers: {
          Authorization: `Bearer ${gsToken}`,
          "Content-Type": "application/json",
        },
        data: { requests: [{ addSheet: { properties: { title: targetTab } } }] },
      });

      // Optional: write header if new
      if (this.writeHeaderIfNew) {
        const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}/values/${encodeURIComponent(`${targetTab}!A1:A1`)}:append`;
        await axios($, {
          method: "POST",
          url: headerUrl,
          params: {
            valueInputOption: this.valueInputOption || "RAW",
            insertDataOption: "INSERT_ROWS",
          },
          headers: {
            Authorization: `Bearer ${gsToken}`,
            "Content-Type": "application/json",
          },
          data: { values: [["Email"]] },
        });
      }
    }

    // Prepare 2D values for append
    const valuesMissing = missingEmails.map(e => [e]);

    let appendedRows = 0;
    if (valuesMissing.length > 0) {
      const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${targetTab}!A:A`)}:append`;

      const appendRes = await axios($, {
        method: "POST",
        url: appendUrl,
        params: {
          valueInputOption: this.valueInputOption || "RAW",
          insertDataOption: "INSERT_ROWS",
        },
        headers: {
          Authorization: `Bearer ${gsToken}`,
          "Content-Type": "application/json",
        },
        data: { values: valuesMissing },
      });

      appendedRows = appendRes?.updates?.updatedRows ?? valuesMissing.length;
    }

    return {
      message: `Checked ${emails.length} emails → ${existingEmails.length} in HubSpot, ${missingEmails.length} not found. Appended ${appendedRows} to '${targetTab}'.`,
      input: {
        sheetName: this.sheetName,
        emailColumn: this.emailColumn,
        readCount: limited.length,
        validEmails: emails.length,
      },
      output: {
        existingCount: existingEmails.length,
        missingCount: missingEmails.length,
        writtenTab: targetTab,
        appendedRows,
        previewMissing: valuesMissing.slice(0, 10),
      },
    };
  },
});
