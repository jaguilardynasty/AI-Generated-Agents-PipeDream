import gmail from "@pipedream/gmail"

export default defineComponent({
  name: "Search Emails by Contacts",
  description: "Build Gmail search query dynamically using contact data to search for emails where any of the contacts appear in To, From, CC, or BCC fields, and search for recent emails from the past 7 days",
  type: "action",
  props: {
    gmail,
    contacts: {
      type: "string[]",
      label: "Contact Emails",
      description: "Array of email addresses to search for in To, From, CC, or BCC fields. You can reference data from previous steps like {{steps.google_sheets.email_column}}",
    },
  },
  methods: {
    buildSearchQuery(contacts) {
      if (!contacts || contacts.length === 0) {
        return "newer_than:7d";
      }
      
      // Build query for each contact (from:email OR to:email OR cc:email)
      const contactQueries = contacts.map(email => {
        // Clean email address (remove any whitespace)
        const cleanEmail = email.trim();
        return `(from:${cleanEmail} OR to:${cleanEmail} OR cc:${cleanEmail})`;
      });
      
      // Combine all contact queries with OR and add date filter
      const combinedQuery = contactQueries.join(' OR ');
      return `(${combinedQuery}) newer_than:7d`;
    },
  },
  async run({ $ }) {
    // Build the search query
    const searchQuery = this.buildSearchQuery(this.contacts);
    
    $.export("searchQuery", searchQuery);
    
    // Search for messages with pagination
    let allMessages = [];
    let nextPageToken = null;
    
    do {
      const response = await this.gmail.listMessages({
        q: searchQuery,
        maxResults: 100,
        pageToken: nextPageToken,
      });
      
      const { messages = [], nextPageToken: token } = response;
      allMessages.push(...messages);
      nextPageToken = token;
    } while (nextPageToken);
    
    // Get full message details for each message
    const emailDetails = [];
    for (const message of allMessages) {
      const fullMessage = await this.gmail.getMessage({ id: message.id });
      
      // Extract key information
      const headers = fullMessage.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "";
      const from = headers.find(h => h.name === "From")?.value || "";
      const to = headers.find(h => h.name === "To")?.value || "";
      const cc = headers.find(h => h.name === "Cc")?.value || "";
      const date = headers.find(h => h.name === "Date")?.value || "";
      
      emailDetails.push({
        id: message.id,
        threadId: fullMessage.threadId,
        subject,
        from,
        to,
        cc,
        date,
        snippet: fullMessage.snippet,
      });
    }
    
    $.export("$summary", `Found ${emailDetails.length} emails matching contacts from the past 7 days`);
    
    return {
      searchQuery,
      emailCount: emailDetails.length,
      emails: emailDetails,
    };
  },
})