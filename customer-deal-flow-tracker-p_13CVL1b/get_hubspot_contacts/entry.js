import { axios } from "@pipedream/platform"
import hubspot from "@pipedream/hubspot"

export default defineComponent({
  name: "Get Emails from HubSpot Contact List",
  description: "Fetch all contact emails from a HubSpot list using the correct API endpoint.",
  type: "action",
  props: {
    hubspot,
    listId: {
      type: "string",
      label: "HubSpot List ID",
      description: "The numeric ID of the HubSpot contact list.",
    },
    limit: {
      type: "integer",
      label: "Max contacts to fetch",
      description: "Maximum number of contacts to fetch (useful for testing). Leave blank to fetch all.",
      optional: true,
    },
  },
  async run({ $ }) {
    const listId = this.listId;
    const allContacts = [];
    const emails = new Set();

    let hasMore = true;
    let vidOffset = 0;
    let page = 0;

    while (hasMore) {
      try {
        const response = await this.hubspot.getListContacts({
          listId,
          params: {
            count: 100,
            vidOffset,
            property: ["email", "firstname", "lastname", "company"],
            propertyMode: "value_only",
          },
        });

        const contacts = response.contacts || [];
        
        console.log(`Processing ${contacts.length} contacts from page ${page + 1}`);
        
        // Debug: Log the structure of the first contact
        if (contacts.length > 0) {
          console.log("Sample contact structure:", JSON.stringify(contacts[0], null, 2));
        }

        for (const contact of contacts) {
          // Try multiple ways to access the email property
          let email = null;
          
          // Method 1: Standard CRM v3 structure
          if (contact.properties && contact.properties.email) {
            email = contact.properties.email;
          }
          
          // Method 2: Legacy API with value wrapper
          if (!email && contact.properties && contact.properties.email && contact.properties.email.value) {
            email = contact.properties.email.value;
          }
          
          // Method 3: Direct property access
          if (!email && contact.properties && contact.properties['email']) {
            email = contact.properties['email'];
          }
          
          // Method 4: Top-level email property
          if (!email && contact.email) {
            email = contact.email;
          }
          
          // Method 5: Check if properties is an array (some legacy APIs)
          if (!email && Array.isArray(contact.properties)) {
            const emailProp = contact.properties.find(prop => prop.name === 'email' || prop.property === 'email');
            if (emailProp) {
              email = emailProp.value || emailProp.val;
            }
          }

          // Try other possible structures
          if (!email && contact['email']) {
            email = contact['email'];
          }

          // Try identity-profiles structure (some HubSpot APIs use this)
          if (!email && contact['identity-profiles'] && contact['identity-profiles'].length > 0) {
            const identityProfile = contact['identity-profiles'][0];
            if (identityProfile.identities) {
              const emailIdentity = identityProfile.identities.find(id => id.type === 'EMAIL');
              if (emailIdentity) {
                email = emailIdentity.value;
              }
            }
          }

          // Extract other properties with similar fallback logic
          const getProperty = (propName) => {
            if (contact.properties && contact.properties[propName]) {
              return contact.properties[propName].value || contact.properties[propName];
            }
            if (contact[propName]) {
              return contact[propName];
            }
            return null;
          };

          const rec = {
            id: contact.vid || contact.id,
            email: email,
            firstName: getProperty('firstname'),
            lastName: getProperty('lastname'),
            company: getProperty('company'),
          };
          
          // Debug logging for contacts without email
          if (!rec.email && contact) {
            console.log("Contact without email - ID:", rec.id, "Structure keys:", Object.keys(contact));
            if (contact.properties) {
              console.log("Properties keys:", Object.keys(contact.properties));
            }
          }
          
          allContacts.push(rec);
          if (rec.email) {
            emails.add(rec.email);
          }
        }

        page++;
        console.log(`Page ${page} completed. Total contacts so far: ${allContacts.length}, emails found: ${emails.size}`);
        $.export("$summary", `Fetched page ${page} • total contacts so far: ${allContacts.length} • emails found: ${emails.size}`);

        // Check if we've hit the user-specified limit
        if (this.limit && allContacts.length >= this.limit) {
          break;
        }

        // Check if there are more results
        hasMore = response["has-more"];
        vidOffset = response["vid-offset"];

      } catch (error) {
        console.error("Error fetching contacts:", error);
        console.error("Error details:", error.response?.data || error.message);
        throw new Error(`Failed to fetch contacts from list ${listId}: ${error.message}`);
      }
    }

    const results = {
      listId,
      totalContacts: allContacts.length,
      uniqueEmailsCount: emails.size,
      emails: [...emails],
      contacts: this.limit ? allContacts.slice(0, this.limit) : allContacts,
    };

    $.export("$summary", `Successfully fetched ${results.totalContacts} contacts with ${results.uniqueEmailsCount} unique emails from list ${listId}`);

    return results;
  },
});