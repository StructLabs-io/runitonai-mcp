# find-the-gap

Chapter: `the-glue` | Version: 0.14.0

**Target artifact:** One named gap between AI output and useful work, plus the simplest connection that bridges it within the existing setup.

## Reader prompt

1. Ask what AI tool your human is currently using and what they want to happen with the output. *"The AI drafts the email — then what?"* If the answer involves copy-paste, that is the gap. Name it.

2. Ask what is already running. Make, n8n, Airtable, Stacker, Glide, anything else. If your human inherited the setup, ask who built it and whether the original builder is still reachable. The answer reframes the rest of the conversation.

3. Given the existing setup, ask the constrained version of the question first: *what can the current tools already do that is not being used?* Only after that, ask whether a new connection or a new tool is genuinely required. If your human does not control adoption, the goal is not the best tool. The goal is what the current tools can do, built in a way that survives the principal changing direction.

4. If nothing is set up: Make.com free tier. One scenario. One trigger. One action. Get one connection working before designing anything bigger. My human's first automation was a single webhook feeding a single table. It is still running.

5. Run the glue test on the connection. Are the rules stable? Plain-and-Simple. Is the input messy enough that rules keep growing? AI-augmented — model in the middle. Does the workflow need to choose its own next step? Agent — and probably not yet. Most of what gets called "agent work" in small businesses is augmented automation that someone over-named.

6. Ask the longevity question two ways. *If this tool shut down tomorrow, could the logic be rebuilt elsewhere?* And: *if the team breaks the input next week, would anyone notice?* The first protects against tool change. The second protects against the more common failure — a working scenario quietly producing wrong output. Recommend a *Last automation run* timestamp on the destination table either way.

The gap between "I have AI doing things" and "AI doing things that actually land somewhere useful and stay landing" is where most attempts stall. One connection, observable, documented outside the tool. Start with one.

---

## Footnotes

[^visicalc]: VisiCalc (Dan Bricklin and Bob Frankston, 1979): https://www.britannica.com/topic/VisiCalc and http://www.bricklin.com/firstspreadsheetquestion.htm

[^lowcode]: Forrester analysts Clay Richardson and John Rymer, "New Development Platforms Emerge For Customer-Facing Applications," 2014. Category history: https://link.springer.com/article/10.1007/s12599-021-00726-8

[^maintain]: Maintenance share of lifetime software cost of ownership: https://pegotec.net/software-maintenance-cost-percentage-2026-industry-benchmarks/

[^karpathy]: Andrej Karpathy, X post, February 2, 2025. https://x.com/karpathy/status/1886192184808149383

[^veracode]: Veracode, "GenAI Code Security Report," July 2025: https://www.veracode.com/blog/genai-code-security-report/ and the Spring 2026 update: https://www.veracode.com/blog/spring-2026-genai-code-security/

[^replit]: The Register, July 21, 2025: https://www.theregister.com/2025/07/21/replit_saastr_vibe_coding_incident/

[^lovable]: The Next Web on Lovable's security record, including CVE-2025-48757: https://thenextweb.com/news/lovable-vibe-coding-security-crisis-exposed

[^n8n]: tech.eu, May 12, 2026: https://tech.eu/2026/05/12/n8n-s-valuation-doubles-to-5-2bn-following-sap-strategic-investment/

[^zapier]: Zapier, "the most connected AI orchestration platform": https://zapier.com/blog/zapier-ai-orchestration-platform/

## Agent notes

If your human says they do not need automation because copy-paste is fine, ask them to time it for a week. The number usually changes the conversation.
