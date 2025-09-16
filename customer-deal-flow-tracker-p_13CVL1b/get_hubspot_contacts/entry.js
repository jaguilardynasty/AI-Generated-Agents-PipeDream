import { axios } from "@pipedream/platform"
import hubspot from "@pipedream/hubspot"

export default defineComponent({
  name: "Get Most-Recent 100 Emails from HubSpot Contact List",
  description: "Fetch the 100 most recently added contact emails from a HubSpot list and return the same structure as the original code.",
  type: "action",
  props: {
    hubspot,
    listId: {
      type: "string",
      label: "HubSpot List ID",
      description: "The numeric ID of the HubSpot contact list.",
    },
  },
  async run({ $ }) {
    const listId = this.listId;
    const allContacts = [];
    const emails = new Set();

    // Hit the 'recent' endpoint (newest-first) and ask for 100
    const url = `https://api.hubapi.com/contacts/v1/lists/${encodeURIComponent(listId)}/contacts/all`;
    const token = this.hubspot.$auth.oauth_access_token;

    let response;
    try {
      response = await axios($, {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        params: {
          count: 150,
          property: ["email", "firstname", "lastname", "company"],
          propertyMode: "value_only",
        },
      });
    } catch (error) {
      console.error("Error fetching recent contacts:", error);
      console.error("Error details:", error.response?.data || error.message);
      throw new Error(`Failed to fetch recent contacts from list ${listId}: ${error.message}`);
    }

    const contacts = Array.isArray(response?.contacts) ? response.contacts : [];
    console.log(`Processing ${contacts.length} recent contacts (newest first)`);

    const getProperty = (contact, propName) => {
      if (contact?.properties?.[propName]?.value != null) return contact.properties[propName].value;
      if (contact?.properties?.[propName] != null) return contact.properties[propName];
      if (contact?.[propName] != null) return contact[propName];
      if (Array.isArray(contact?.properties)) {
        const p = contact.properties.find(x => x.name === propName || x.property === propName);
        if (p) return p.value ?? p.val ?? null;
      }
      return null;
    };

    for (const contact of contacts) {
      // Robust email extraction across legacy shapes
      let email =
        contact?.properties?.email?.value ??
        contact?.properties?.email ??
        contact?.email ??
        contact?.["email"] ??
        null;

      if (!email && contact?.["identity-profiles"]?.length) {
        const idProfile = contact["identity-profiles"][0];
        const emailIdentity = idProfile?.identities?.find(id => id.type === "EMAIL");
        if (emailIdentity?.value) email = emailIdentity.value;
      }

      const rec = {
        id: contact.vid ?? contact.id ?? null,
        email,
        firstName: getProperty(contact, "firstname"),
        lastName: getProperty(contact, "lastname"),
        company: getProperty(contact, "company"),
      };

      allContacts.push(rec);
      if (rec.email) emails.add(rec.email);
    }

    $.export(
      "$summary",
      `Successfully fetched ${allContacts.length} recent contacts • unique emails: ${emails.size} • list ${listId}`
    );

    // ⬇️ Return the EXACT SAME SHAPE as your original code
    return {
      listId,
      totalContacts: allContacts.length,
      uniqueEmailsCount: emails.size,
      emails: [...emails],            // array of email strings
      contacts: allContacts,          // normalized contact records
    };
  },
});
