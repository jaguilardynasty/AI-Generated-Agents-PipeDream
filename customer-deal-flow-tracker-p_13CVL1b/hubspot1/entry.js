import hubspot from "@pipedream/hubspot";
import { axios } from "@pipedream/platform";

export default defineComponent({
  name: "Update HubSpot Deals with Follow Up Info",
  description:
    "Find contacts by email, gather deals (direct + via companies), and set the 'Follow Up Date' + 'Follow Up Message' deal properties.",
  type: "action",
  props: {
    hubspot,
    contactsInput: {
      type: "any",
      label: "Contacts input",
      description:
        "Map to your previous step (e.g., steps.agent.$return_value). Should include { email, followUps:[{messageDate,quote,followUpDate}] }.",
    },
    followUpDateProperty: {
      type: "string",
      label: "Deal property INTERNAL name for Follow Up Date",
      default: "follow_up_date",
    },
    followUpMessageProperty: {
      type: "string",
      label: "Deal property INTERNAL name for Follow Up Message",
      default: "follow_up_message",
    },
    onlyUpdateOpenDeals: {
      type: "boolean",
      label: "Only update non-closed deals",
      default: true,
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
    };

    const norm = (s) => String(s || "").trim().toLowerCase();
    const explain = (e) => {
      try {
        return JSON.stringify(e?.response?.data || e?.data || e?.message);
      } catch {
        return String(e?.message || e);
      }
    };

    let contacts = [];
    const raw = this.contactsInput;
    if (Array.isArray(raw)) contacts = raw;
    else if (raw && Array.isArray(raw.contacts)) contacts = raw.contacts;
    else if (raw && typeof raw === "object") {
      contacts = Object.entries(raw).map(([email, v]) => ({
        email,
        followUps: v.followUps || [],
      }));
    }

    if (!contacts.length)
      throw new Error("No valid contacts found (need items with { email, followUps }).");

    // ---- HubSpot helpers ----
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
      return (resp?.results || []).map((a) => a.toObjectId || a.id).filter(Boolean);
    };

    const batchGetDeals = async (ids, props) => {
      if (!ids.length) return [];
      const resp = await this.hubspot.batchGetObjects({
        objectType: "deals",
        data: { inputs: ids.map((id) => ({ id })), properties: props },
      });
      return resp?.results || [];
    };

    const isOpen = (deal) => {
      if (!this.onlyUpdateOpenDeals) return true;
      const stage = norm(deal?.properties?.dealstage);
      return !stage.includes("closed");
    };

    // ---- Main loop ----
    for (const item of contacts) {
      const { email, followUps } = item;
      results.processedContacts++;

      try {
        const contact = await searchContact(email);
        if (!contact) {
          results.missingContacts.push({ email, reason: "contact not found" });
          continue;
        }

        // Deals via contact + companies
        const directDealIds = await getAssocIds({
          objectType: "contacts",
          objectId: contact.id,
          toObjectType: "deals",
        });

        const companyIds = await getAssocIds({
          objectType: "contacts",
          objectId: contact.id,
          toObjectType: "companies",
        });
        let viaCompanyDealIds = [];
        for (const cid of companyIds) {
          const ids = await getAssocIds({
            objectType: "companies",
            objectId: cid,
            toObjectType: "deals",
          });
          viaCompanyDealIds.push(...ids);
        }

        const dealIds = Array.from(new Set([...directDealIds, ...viaCompanyDealIds]));
        if (!dealIds.length) {
          results.noDeals.push({ email, reason: "no deals associated" });
          continue;
        }

        const deals = await batchGetDeals(dealIds, ["dealname", "dealstage"]);
        const targets = deals.filter(isOpen);
        if (!targets.length) {
          results.noDeals.push({ email, reason: "all associated deals are closed" });
          continue;
        }

        // Build update values
        if (!followUps || !followUps.length) {
          results.noDeals.push({ email, reason: "no follow-up info provided" });
          continue;
        }

        const latest = followUps[followUps.length - 1];
        const followUpDate = latest.followUpDate;
        const followUpMsg = `Message on ${latest.messageDate}: "${latest.quote}"`;

        for (const d of targets) {
          try {
            await this.hubspot.updateObject({
              objectType: "deals",
              objectId: d.id,
              data: {
                properties: {
                  [this.followUpDateProperty]: followUpDate,
                  [this.followUpMessageProperty]: followUpMsg,
                },
              },
            });

            results.updatedDeals.push({
              dealId: d.id,
              dealName: d.properties?.dealname,
              followUpDate,
              followUpMsg,
              contactEmail: email,
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
