import { axios } from "@pipedream/platform"

export default defineComponent({
  name: "Analyze Email Threads for Contact Status",
  description: "Uses AI to analyze email threads and determine contact status and last check-in date",
  type: "action",
  props: {
    emailThreads: {
      type: "any",
      label: "Email Threads",
      description: "Email thread data from previous step - an object with email addresses as keys"
    },
    model: {
      type: "string",
      label: "OpenAI Model",
      description: "OpenAI model to use for analysis",
      options: [
        "gpt-4o",
        "gpt-4o-mini", 
        "o3",
      ],
      default: "gpt-4o"
    }
  },
  async run({ $ }) {
    const threads = this.emailThreads || {};
    const results = [];
    const parsingErrors = [];

    for (const emailAddress in threads) {
      const thread = threads[emailAddress];
      
      try {
        const emailContent = typeof thread === 'string' ? thread : JSON.stringify(thread);
        
        const systemPrompt = `You are an expert at analyzing email conversations to determine customer status and engagement timeline.

CRITICAL: You MUST respond with valid JSON only. Do not include any text before or after the JSON object.

Analyze the email thread and determine:
1. The contact's current status - choose exactly one of: "said they would sign up or pay now", "said they would sign up or pay at a later date", "said they were interested", "not interested or doubtful", or "no messages found"
2. The date and time of the most recent check-in or meaningful interaction
3. Evidence from the conversation that supports your status determination

For the date/time, look for the most recent timestamp when there was meaningful interaction (not just automated messages).

Status definitions:
- "said they would sign up or pay now": Contact explicitly indicated immediate readiness to purchase or sign up
- "said they would sign up or pay at a later date": Contact expressed intent to purchase/sign up but specified a future timeframe
- "said they were interested": Contact showed interest but hasn't said they would sign up yet.
- "not interested or doubtful": Contact seems doubtful as to wether they want to do this.
- "no messages found": No messages found for the contact

These statuses returned should be the most recent status update of the user.

You MUST respond with valid JSON in this exact format with no additional text:
{
  "status": "one of the five statuses",
  "lastCheckinDate": "YYYY-MM-DD HH:MM:SS format or null if not found",
  "evidence": "specific quotes or details from the conversation that support the status",
  "confidence": "high, medium, or low"
}`;

        const response = await $.services.openai.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Analyze this email thread for ${emailAddress}:\n\n${emailContent}` }
          ],
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: "json_object" }
        });

        const aiResponse = response.choices[0].message.content;
        let analysisResult;

        try {
          analysisResult = JSON.parse(aiResponse);
          
          // Validate that required fields exist and have correct values
          const validStatuses = [
            "said they would sign up or pay now",
            "said they would sign up or pay at a later date", 
            "said they were interested",
            "not interested or doubtful",
            "no messages found",
            
          ];
          
          if (!analysisResult.status || !validStatuses.includes(analysisResult.status)) {
            throw new Error("Invalid or missing status field");
          }
          
          if (!analysisResult.confidence || !["high", "medium", "low"].includes(analysisResult.confidence)) {
            analysisResult.confidence = "low";
          }
          
        } catch (parseError) {
          // Log the parsing error details
          const errorDetails = {
            email: emailAddress,
            error: parseError.message,
            aiResponse: aiResponse,
            responseLength: aiResponse?.length || 0
          };
          
          parsingErrors.push(errorDetails);
          console.log("JSON parsing failed for email:", emailAddress);
          console.log("AI Response:", aiResponse);
          console.log("Parse Error:", parseError.message);
          
          // Fallback if JSON parsing fails
          analysisResult = {
            status: "no messages found",
            lastCheckinDate: null,
            evidence: `JSON parsing failed. AI response: ${aiResponse?.substring(0, 200)}...`,
            confidence: "low"
          };
        }

        results.push({
          email: emailAddress,
          status: analysisResult.status,
          lastCheckinDate: analysisResult.lastCheckinDate,
          evidence: analysisResult.evidence,
          confidence: analysisResult.confidence,
          originalThread: thread
        });

      } catch (error) {
        console.log("Error processing email thread for:", emailAddress);
        console.log("Error details:", error.message);
        
        results.push({
          email: emailAddress,
          status: "no messages found",
          lastCheckinDate: null,
          evidence: "Error processing thread",
          confidence: "low",
          error: error.message,
          originalThread: thread
        });
      }
    }

    // Export parsing errors for debugging if any occurred
    if (parsingErrors.length > 0) {
      $.export("parsingErrors", parsingErrors);
    }

    const successfulParses = results.filter(r => !r.error && r.confidence !== "low" || !r.evidence?.includes("JSON parsing failed"));
    const failedParses = results.length - successfulParses.length;

    $.export("$summary", `Analyzed ${results.length} email threads. ${successfulParses.length} successful, ${failedParses} failed. ${parsingErrors.length} JSON parsing errors.`);
    
    return {
      totalContacts: results.length,
      successfulAnalyses: successfulParses.length,
      failedAnalyses: failedParses,
      jsonParsingErrors: parsingErrors.length,
      statusBreakdown: {
        signUpNow: results.filter(r => r.status === 'said they would sign up or pay now').length,
        signUpLater: results.filter(r => r.status === 'said they would sign up or pay at a later date').length,
        interested: results.filter(r => r.status === 'said they were interested').length,
        noMessages: results.filter(r => r.status === 'no messages found').length,
        Notinterested: results.filter(r => r.status === 'not interested or doubtful').length
      },
      contacts: results,
      ...(parsingErrors.length > 0 && { debugInfo: parsingErrors })
    };
  }
})