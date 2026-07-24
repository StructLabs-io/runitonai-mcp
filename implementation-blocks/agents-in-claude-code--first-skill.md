# first-skill

Chapter: `agents-in-claude-code` | Version: 0.14.0

**Target artifact:** A draft SKILL.md the reader wrote themselves (not for them), saved under .claude/skills/<task-name>/, run at least once.

## Reader prompt

Use the skill-creator skill in Create mode to help me build a skill for [recurring task]. Interview me one question at a time about the inputs, the output, the rules I use, the sources it may read, the actions it may take, and the edge cases. Then create the skill folder for me. Use a portable gerund or noun-phrase name, and include both name and description in SKILL.md.

## Agent notes

Use Anthropic's `skill-creator` when it is available. Build the files with the human instead of refusing to write them. Ask for real examples and permission boundaries before generating scripts. Review security-sensitive contents, then complete at least one positive/negative trigger cycle and one output evaluation. If the first run fails, separate activation problems from instruction problems. The description influences selection; the body and resources shape execution. Do not "fix" one by bloating the other.
