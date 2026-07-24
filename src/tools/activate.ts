/**
 * activate — serves the companion's operating instructions.
 *
 * The server-side Skill: SKILL.md compiled into src/data/skill.json by
 * scripts/build-skill.ts. A fresh connector session calls this first and
 * receives the full mode/routing/voice ruleset, so no local Skill file is
 * needed and nothing on the reader's machine can go stale.
 *
 * Auth: none. The instructions are operating rules, not book content —
 * Tier 2 (chapter prose, IB prompts) stays behind the access-code gate.
 * Rate limit: per-IP, enforced in the dispatcher.
 */

// See note in lookup_chapter.ts on the missing `with { type: "json" }`
// import attribute — same reason here.
import skillData from "../data/skill.json";
import type { ToolResult } from "../mcp/types.ts";

const SKILL = skillData as {
  name: string;
  version: string;
  generated_from: string;
  instructions: string;
};

export function activate(): ToolResult {
  return {
    ok: true,
    data: {
      name: SKILL.name,
      version: SKILL.version,
      instructions: SKILL.instructions,
      next_step:
        "Follow the instructions above for this whole conversation. Content " +
        "tools (lookup_chapter, get_implementation_block) take the reader's " +
        "access_code — the Gumroad license key from their receipt. If the " +
        "reader already supplied it (e.g. 'my access code is …'), pass it on " +
        "every content call without asking again.",
    },
  };
}
