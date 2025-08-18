import gmail from "@pipedream/gmail"

export default defineComponent({
  name: "Search Gmail by Multiple Email Addresses",
  description: "Search Gmail for all email threads associated with specific email addresses and organize by sender",
  type: "action",
  props: {
    gmail,
    emailAddresses: {
      type: "string[]",
      label: "Email Addresses",
      description: "Array of email addresses to search for in Gmail",
    },
  },
  async run({ $ }) {
    // Get email addresses from the prop and add test email
    const inputEmails = this.emailAddresses || [];
    const emailAddresses = [...inputEmails, 'kevin@superpower.com'];
    
    // Fallback to empty array if no emails found
    if (!emailAddresses || emailAddresses.length === 0) {
      $.export("$summary", "No email addresses provided");
      return {
        error: "No email addresses provided",
        results: {}
      };
    }
    
    const results = {};
    
    for (const emailAddress of emailAddresses) {
      // Search for emails from OR to this specific email address
      const query = `from:${emailAddress} OR to:${emailAddress}`;
      
      try {
        const { messages = [] } = await this.gmail.listMessages({
          q: query,
        });
        
        results[emailAddress] = {
          count: messages.length,
          messages: []
        };
        
        // Get details for each message
        for (const message of messages) {
          const messageDetails = await this.gmail.getMessage({
            id: message.id
          });
          
          const headers = messageDetails.payload.headers;
          const subject = headers.find(h => h.name === "Subject")?.value || "No Subject";
          const from = headers.find(h => h.name === "From")?.value || "Unknown Sender";
          const to = headers.find(h => h.name === "To")?.value || "Unknown Recipient";
          const date = headers.find(h => h.name === "Date")?.value || "Unknown Date";
          
          results[emailAddress].messages.push({
            id: message.id,
            threadId: messageDetails.threadId,
            subject,
            from,
            to,
            date,
            snippet: messageDetails.snippet
          });
        }
        
        // Sort messages by date (newest first)
        results[emailAddress].messages.sort((a, b) => new Date(b.date) - new Date(a.date));
        
      } catch (error) {
        results[emailAddress] = {
          error: error.message,
          count: 0,
          messages: []
        };
      }
    }
    
    const totalMessages = Object.values(results).reduce((sum, result) => sum + result.count, 0);
    
    $.export("$summary", `Found ${totalMessages} messages across ${emailAddresses.length} email addresses (including test email kevin@superpower.com)`);
    
    return results;
  }
})