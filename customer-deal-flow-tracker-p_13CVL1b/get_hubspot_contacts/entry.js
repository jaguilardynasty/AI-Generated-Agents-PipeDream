import { axios } from "@pipedream/platform"
import hubspot from "@pipedream/hubspot"

export default defineComponent({
  name: "Get Paginated Contacts from HubSpot List",
  description: "Fetch contacts from a HubSpot list with offset + limit, so you can pull different ranges (1–50, 51–100, etc.).",
  type: "action",
  props: {
    hubspot,
    listId: {
      type: "string",
      label: "HubSpot List ID",
      description: "The numeric ID of the HubSpot contact list.",
    },
    offset: {
      type: "integer",
      label: "Offset",
      description: "Where to start (e.g. 0 for first record, 50 for the 51st).",
      default: 0,
    },
    limit: {
      type: "integer",
      label: "Limit",
      description: "How many records to fetch (max 100 per request).",
      default: 50,
    },
  },
  async run({ $ }) {
    const { listId, offset, limit } = this;
    const allContacts = [];
    const emails = new Set();

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
          count: limit,
          vidOffset: offset, // pagination start
          property: ["email", "firstname", "lastname", "company"],
          propertyMode: "value_only",
        },
      });
    } catch (error) {
      console.error("Error fetching contacts:", error);
      console.error("Error details:", error.response?.data || error.message);
      throw new Error(`Failed to fetch contacts from list ${listId}: ${error.message}`);
    }

    const contacts = Array.isArray(response?.contacts) ? response.contacts : [];
    console.log(`Processing ${contacts.length} contacts starting at offset ${offset}`);

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
      `Fetched ${allContacts.length} contacts (offset ${offset}, limit ${limit}) • unique emails: ${emails.size} • list ${listId}`
    );

    return {
      listId,
      offset,
      limit,
      totalContacts: allContacts.length,
      uniqueEmailsCount: emails.size,
      emails: [...emails],
      contacts: allContacts,
    };
  },
});
