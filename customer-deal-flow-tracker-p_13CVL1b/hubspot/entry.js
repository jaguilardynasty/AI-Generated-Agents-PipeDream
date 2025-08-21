import hubspot from "@pipedream/hubspot";
import { axios } from "@pipedream/platform";

export default defineComponent({
  name: "Update HubSpot Deals from Contact Status (auto-property lookup)",
  description: "Find contacts by email (primary or additional), gather deals (direct + via companies), and set the 'Email Status' deal property.",
  type: "action",
  props: {
    hubspot,
    contactsInput: {
      type: "any",
      label: "Contacts input",
      description: "Map to your previous step (e.g., steps.agent.$return_value). Accepts an array of { email, status } or an object with { contacts: [...] }.",
    },
    // If you ALREADY know the internal name (e.g., "email_status"), set it here.
    statusPropertyInternal: {
      type: "string",
      label: "Deal property INTERNAL name (optional)",
      description: "If blank, the step will look up a property whose label/display name equals 'Email Status'.",
      optional: true,
    },
    // Used only when internal name is blank.
    statusPropertyLabel: {
      type: "string",
      label: "Deal property LABEL to look up",
      default: "Email Status",
      optional: true,
    },
    onlyUpdateOpenDeals: {
      type: "boolean",
      label: "Only update non-closed deals",
      default: false,
      optional: true,
    },
  },

  async run({ $ }) {
    const results = {
      processedContacts: 0,
      updatedDeals: [],
      noDeals: [],
      missingContacts: [],
      errors: [],
      property: null,
    };

    const norm = (s) => String(s || "").trim();
    const normLower = (s) => norm(s).toLowerCase();
    const explain = (e) => {
      try { return JSON.stringify(e?.response?.data || e?.data || e?.message); }
      catch { return String(e?.message || e); }
    };

    // ---- Parse contacts ----
    let contacts = [];
    const raw = this.contactsInput;
    if (Array.isArray(raw)) contacts = raw;
    else if (raw && Array.isArray(raw.contacts)) contacts = raw.contacts;
    else if (raw && typeof raw === "object") {
      contacts = Object.entries(raw).map(([email, v]) => ({
        email, status: (typeof v === "object" && v) ? v.status : v,
      }));
    }
    contacts = contacts
      .map(c => ({ email: normLower(c.email), status: norm(c.status) }))
      .filter(c => c.email && c.status);

    if (!contacts.length) throw new Error("No valid contacts found (need items with { email, status }).");

    // ---- Resolve deal property ----
    const token = this.hubspot.$auth.oauth_access_token;
    const headers = { Authorization: `Bearer ${token}` };

    let propertyName = norm(this.statusPropertyInternal);
    let propertyDef = null;

    const fetchProperty = async (name) => {
      return await axios($, {
        method: "GET",
        url: `https://api.hubapi.com/crm/v3/properties/deals/${encodeURIComponent(name)}`,
        headers,
      });
    };

    if (propertyName) {
      try {
        propertyDef = await fetchProperty(propertyName);
      } catch (e) {
        throw new Error(`Deal property "${propertyName}" not found. ${explain(e)}`);
      }
    } else {
      // Find by LABEL/display name (case-insensitive)
      const list = await axios($, {
        method: "GET",
        url: `https://api.hubapi.com/crm/v3/properties/deals`,
        headers,
        params: { archived: false },
      });
      const want = normLower(this.statusPropertyLabel || "Email Status");
      propertyDef = (list?.results || []).find(p => normLower(p.label) === want || normLower(p.displayOrderLabel) === want);
      if (!propertyDef) {
        throw new Error(`Could not find a deals property labeled "${this.statusPropertyLabel}". Set the internal name explicitly if needed.`);
      }
      propertyName = propertyDef.name;
    }

    results.property = { internalName: propertyName, label: propertyDef.label, type: propertyDef.type, fieldType: propertyDef.fieldType };

    // Build enum mapping if needed
    let enumMap = null; // label/value (lowercased) -> value
    if (propertyDef.type === "enumeration" && Array.isArray(propertyDef.options)) {
      enumMap = new Map();
      for (const opt of propertyDef.options) {
        const val = norm(opt.value);
        const lab = norm(opt.label);
        enumMap.set(normLower(lab), val);
        enumMap.set(normLower(val), val);
      }
    }

    // ---- HubSpot helpers via component ----
    const searchContact = async (email) => {
      const resp = await this.hubspot.searchCRM({
        object: "contacts",
        data: {
          filterGroups: [
            { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
            { filters: [{ propertyName: "hs_additional_emails", operator: "CONTAINS_TOKEN", value: email }] },
          ],
          properties: ["email", "hs_additional_emails", "firstname", "lastname"],
          limit: 1,
        },
      });
      return (resp?.results || [])[0] || null;
    };

    const getAssocIds = async ({ objectType, objectId, toObjectType }) => {
      const resp = await this.hubspot.getAssociations({ objectType, objectId, toObjectType });
      return (resp?.results || []).map(a => a.toObjectId || a.id).filter(Boolean);
    };

    const batchGetDeals = async (ids, props) => {
      if (!ids.length) return [];
      const resp = await this.hubspot.batchGetObjects({
        objectType: "deals",
        data: { inputs: ids.map(id => ({ id })), properties: props },
      });
      return resp?.results || [];
    };

    const isOpen = (deal) => {
      if (!this.onlyUpdateOpenDeals) return true;
      const stage = normLower(deal?.properties?.dealstage);
      return !(stage.includes("closed") || stage.includes("closedwon") || stage.includes("closed_lost") || stage.includes("closedlost"));
    };

    // ---- Main loop ----
    for (const item of contacts) {
      const { email, status } = item;
      results.processedContacts++;

      try {
        const contact = await searchContact(email);
        if (!contact) {
          results.missingContacts.push({ email, reason: "contact not found" });
          continue;
        }

        // Deals directly on contact
        const directDealIds = await getAssocIds({
          objectType: "contacts", objectId: contact.id, toObjectType: "deals",
        });

        // Deals via companies
        const companyIds = await getAssocIds({
          objectType: "contacts", objectId: contact.id, toObjectType: "companies",
        });
        let viaCompanyDealIds = [];
        for (const cid of companyIds) {
          const ids = await getAssocIds({
            objectType: "companies", objectId: cid, toObjectType: "deals",
          });
          viaCompanyDealIds.push(...ids);
        }

        const dealIds = Array.from(new Set([...directDealIds, ...viaCompanyDealIds]));
        if (!dealIds.length) {
          results.noDeals.push({ email, reason: "no deals associated to contact/company" });
          continue;
        }

        const deals = await batchGetDeals(dealIds, ["dealname", "dealstage", propertyName]);
        const targets = deals.filter(isOpen);
        if (!targets.length) {
          results.noDeals.push({ email, reason: "all associated deals filtered out (closed)" });
          continue;
        }

        // Map status to correct value (for enums)
        let valueToSet = norm(status);
        if (enumMap) {
          const hit = enumMap.get(normLower(status));
          if (!hit) {
            results.errors.push({
              email,
              error: `Status "${status}" not a valid option for property "${propertyName}". Allowed: ${Array.from(new Set([...enumMap.keys()])).slice(0, 20).join(", ")}...`,
            });
            continue;
          }
          valueToSet = hit;
        }

        // Update deals (single updates for widest compatibility)
        for (const d of targets) {
          try {
            await this.hubspot.updateObject({
              objectType: "deals",
              objectId: d.id,
              data: { properties: { [propertyName]: valueToSet } },
            });

            results.updatedDeals.push({
              dealId: d.id,
              dealName: d.properties?.dealname,
              previous: d.properties?.[propertyName],
              updated: valueToSet,
              contactEmail: email,
              via: directDealIds.includes(d.id) ? "contact" : "company",
            });
          } catch (e) {
            results.errors.push({ email, dealId: d.id, error: explain(e) });
          }
        }

      } catch (e) {
        results.errors.push({ email, error: explain(e) });
      }
    }

    const summary = `Processed ${results.processedContacts} contact(s): updated ${results.updatedDeals.length} deal(s), ${results.noDeals.length} with no deals, ${results.missingContacts.length} missing, ${results.errors.length} error(s).`;
    $.export("$summary", summary);
    return { summary, ...results };
  },
});
