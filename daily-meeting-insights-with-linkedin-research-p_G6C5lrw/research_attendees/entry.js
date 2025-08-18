import linkedin from "@pipedream/linkedin";

export default defineComponent({
  name: "Research Calendar Event Attendees",
  description: "Extract attendee information from Google Calendar events and prepare structured research notes for LinkedIn lookup",
  type: "action",
  props: {
    linkedin,
    calendarEvents: {
      type: "any",
      label: "Calendar Events",
      description: "Calendar events data from previous step containing attendee information"
    },
    max: {
      type: "integer", 
      label: "Max Attendees to Process",
      description: "Maximum number of attendees to research",
      default: 10,
      optional: true
    }
  },
  async run({ $ }) {
    const events = Array.isArray(this.calendarEvents) ? this.calendarEvents : [this.calendarEvents];
    const allAttendees = new Map(); // Use Map to deduplicate by email
    
    // Extract attendees from all calendar events
    for (const event of events) {
      if (event.attendees && Array.isArray(event.attendees)) {
        for (const attendee of event.attendees) {
          if (attendee.email) {
            const key = attendee.email.toLowerCase();
            if (!allAttendees.has(key)) {
              allAttendees.set(key, {
                email: attendee.email,
                name: attendee.displayName || attendee.email.split('@')[0],
                status: attendee.responseStatus,
                organizer: attendee.organizer || false,
                events: []
              });
            }
            // Add event info to attendee
            allAttendees.get(key).events.push({
              title: event.summary,
              start: event.start?.dateTime || event.start?.date,
              id: event.id
            });
          }
        }
      }
    }

    const attendeeList = Array.from(allAttendees.values()).slice(0, this.max);
    
    if (attendeeList.length === 0) {
      $.export("$summary", "No attendees found in calendar events");
      return { attendees: [], message: "No attendees found" };
    }

    // Get current user profile for context
    let currentProfile = null;
    try {
      currentProfile = await this.linkedin.getCurrentMemberProfile({ $ });
    } catch (error) {
      console.log("Could not fetch current LinkedIn profile:", error.message);
    }

    // Process each attendee and generate research structure using AI
    const researchResults = [];
    
    for (const attendee of attendeeList) {
      const attendeeInfo = {
        email: attendee.email,
        name: attendee.name,
        status: attendee.status,
        organizer: attendee.organizer,
        events: attendee.events,
        company: null,
        domain: attendee.email.split('@')[1],
        researchNotes: []
      };

      // Extract company info from email domain
      const domain = attendee.email.split('@')[1];
      if (domain && !domain.includes('gmail') && !domain.includes('yahoo') && !domain.includes('hotmail')) {
        attendeeInfo.company = domain.split('.')[0];
      }

      // Use AI to generate research framework and questions
      try {
        const researchPrompt = `
        I need to research a meeting attendee for LinkedIn. Here's what I know:
        - Name: ${attendee.name}
        - Email: ${attendee.email}
        - Company Domain: ${domain}
        - Meeting Events: ${attendee.events.map(e => e.title).join(', ')}
        
        Please provide 3-4 specific research bullet points I should look for when searching for this person on LinkedIn, focusing on:
        1. Their current role and responsibilities
        2. Company background and industry
        3. Recent professional activities or achievements
        4. Relevant experience for our meeting context
        
        Format as concise bullet points starting with action verbs like "Verify", "Check", "Look for", etc.
        `;

        const aiResponse = await $.services.openai.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are a professional research assistant helping prepare for business meetings." },
            { role: "user", content: researchPrompt }
          ],
          temperature: 0.7,
          max_tokens: 300
        });

        attendeeInfo.researchNotes = aiResponse.choices[0].message.content
          .split('\n')
          .filter(line => line.trim() && (line.includes('•') || line.includes('-') || line.match(/^\d\./)))
          .slice(0, 4);

      } catch (error) {
        console.log(`Error generating research notes for ${attendee.email}:`, error.message);
        attendeeInfo.researchNotes = [
          `• Verify current role at ${attendeeInfo.company || 'their company'}`,
          "• Check recent professional updates and posts",
          "• Look for relevant industry experience",
          "• Review connection network and mutual contacts"
        ];
      }

      // Try to search for organizations if we have company info
      if (attendeeInfo.company) {
        try {
          const orgSearch = await this.linkedin.searchOrganizations(`search&keywords=${encodeURIComponent(attendeeInfo.company)}`, {
            $,
            params: { count: 5 }
          });
          
          if (orgSearch.elements && orgSearch.elements.length > 0) {
            attendeeInfo.linkedinCompanyInfo = orgSearch.elements[0];
          }
        } catch (error) {
          console.log(`Error searching organizations for ${attendeeInfo.company}:`, error.message);
        }
      }

      researchResults.push(attendeeInfo);
    }

    $.export("$summary", `Successfully prepared research framework for ${researchResults.length} attendees from ${events.length} calendar events`);

    return {
      totalAttendees: researchResults.length,
      currentUserProfile: currentProfile ? {
        name: `${currentProfile.localizedFirstName} ${currentProfile.localizedLastName}`,
        headline: currentProfile.localizedHeadline
      } : null,
      attendeeResearch: researchResults,
      researchInstructions: [
        "1. Search LinkedIn for each attendee using their name and company",
        "2. Review their current role and company information", 
        "3. Check recent posts and professional activity",
        "4. Look for mutual connections and shared interests",
        "5. Note relevant experience for meeting context"
      ],
      note: "Due to LinkedIn API limitations, manual LinkedIn research is required. Use the provided research framework for each attendee."
    };
  }
});