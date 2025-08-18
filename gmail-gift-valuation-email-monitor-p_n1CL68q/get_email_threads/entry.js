import gmail from "@pipedream/gmail"

export default defineComponent({
  name: "Extract Thread Data from Search Results",
  description: "Extract emails from search results and retrieve complete thread data for each unique thread ID",
  type: "action",
  props: {
    gmail,
    search_results: {
      type: "object",
      label: "Search Results",
      description: "The search results from the previous step containing { searchQuery, emailCount, emails }",
    },
  },
  async run({ $ }) {
    // Extract emails from search results
    const { emails } = this.search_results;
    
    if (!emails || !Array.isArray(emails)) {
      throw new Error("Invalid search results format. Expected emails array in search_results.emails");
    }

    if (emails.length === 0) {
      $.export("$summary", "No emails found in search results");
      return {
        threadCount: 0,
        threads: [],
      };
    }

    // Get unique thread IDs
    const uniqueThreadIds = [...new Set(emails.map(email => email.threadId).filter(Boolean))];
    
    if (uniqueThreadIds.length === 0) {
      $.export("$summary", "No thread IDs found in search results");
      return {
        threadCount: 0,
        threads: [],
      };
    }

    // Fetch complete thread data for each unique thread ID
    const threads = [];
    const client = this.gmail._client();

    for (const threadId of uniqueThreadIds) {
      try {
        const { data: thread } = await client.users.threads.get({
          userId: "me",
          id: threadId,
        });
        threads.push(thread);
      } catch (error) {
        console.error(`Failed to fetch thread ${threadId}:`, error.message);
        // Continue with other threads even if one fails
      }
    }

    $.export("$summary", `Successfully retrieved ${threads.length} threads from ${uniqueThreadIds.length} unique thread IDs found in search results`);

    return {
      threadCount: threads.length,
      originalEmailCount: emails.length,
      uniqueThreadIds: uniqueThreadIds.length,
      threads,
    };
  },
})