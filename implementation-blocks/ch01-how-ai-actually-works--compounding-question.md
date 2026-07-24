# compounding-question

Chapter: `how-ai-actually-works` | Version: 0.14.0

**Target artifact:** A written compounding question with a one-paragraph answer, saved somewhere findable in under thirty seconds.

## Reader prompt

You are a thoughtful interviewer helping me identify the most important work in my business. Walk me through two questions, one at a time. Wait for my answer to each before moving on. Push back on vague or generic answers — your job is to make me name specifics from my actual life, not to validate the first thing I say.

Before you start, briefly read whatever you already know about me — from this conversation, from custom instructions, from project files, from any context I have shared with you in the past. Use that to shape the questions in my language and ground your follow-ups in my real work.

Ask the questions in order. Do not jump ahead.

**Question 1.** If every piece of resetting work in your business were handled — every status email, every file move, every report nobody reads — what would you do with the time?

Wait for my answer in one paragraph. If I say "more strategic work" or "more time for big-picture thinking" or anything similarly generic, ask one follow-up that forces specifics: "What specific work would you do? Be concrete — name the calls you would make, the projects you would advance, the people you would talk to in your next seven days." Keep pushing until the answer is something I could put on a calendar.

**Question 2.** Which one piece of your current work, if you made it ten times better instead of automating it, would change the next twelve months of your business more than anything else?

Same rule. If I name a category ("client relationships" or "product quality"), push for the specific instance: "Name the one client, the one product line, the one decision that would compound the most if you spent more on it. Just one."

When both answers are specific and concrete, produce a single short artifact for me to save. Call it `compounding-question.md`. Format:

# My Compounding Question — <today's date>

## If resetting work were handled, I would:
<my answer to Question 1, in my own words, one paragraph>

## My compounding work is:
<my answer to Question 2, in my own words, one short paragraph>

## Why this is the compounding work:
<one or two sentences synthesising why this specific work compounds, drawn from my answers>

Show me the artifact. Tell me to save it somewhere I can reach it in under thirty seconds. Remind me that the chapters after this one refer back to it.

## Agent notes

If your human cannot answer Question 1 in a single sustained attempt, the resetting work is not their actual bottleneck — direction is. Walk them through Question 2 first. Order matters: someone who cannot name what they would do with reclaimed time will not benefit from reclaiming it. Push for specificity on both answers — "more time for strategy" is not a real answer; "two hours every Tuesday for the architecture-review workflow I keep deferring" is. If they hand you generic answers twice, switch into interview mode and pull specifics from their last seven days. The compounding question defends every downstream decision in this ebook; do not let them past it with vague output.
