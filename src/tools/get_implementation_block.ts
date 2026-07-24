/**
 * get_implementation_block — returns a structured IB or, in list mode, the set
 * of IBs available in a chapter.
 *
 * Auth: bearer token required.
 * Rate limit: 60 requests per token per hour.
 *
 * Phase 1 has exactly one IB per chapter (six v1 slugs, per plan §9 Change 2),
 * so list mode mostly serves as a defensive branch for v0.15.0+ when a chapter
 * may grow a second IB.
 */

// See note in lookup_chapter.ts on the missing `with { type: "json" }`
// import attribute — same reason here.
import ibsData from "../data/ibs.json";
import type { ToolResult } from "../mcp/types.ts";

interface IBRow {
  chapter_id: string;
  name: string;
  reader_prompt: string;
  agent_notes: string;
  target_artifact: string;
  version: string;
}

const IBS = ibsData as IBRow[];

export interface GetImplementationBlockInput {
  chapter_id: string;
  name?: string;
}

function oneLiner(ib: IBRow): string {
  return ib.target_artifact;
}

export async function getImplementationBlock(
  input: GetImplementationBlockInput,
): Promise<ToolResult> {
  if (!input.chapter_id) {
    return {
      ok: false,
      error: "invalid_input",
      details: { reason: "chapter_id is required" },
    };
  }

  const chapterIBs = IBS.filter((ib) => ib.chapter_id === input.chapter_id);
  if (chapterIBs.length === 0) {
    return {
      ok: false,
      error: "ib_not_found",
      details: {
        chapter_id: input.chapter_id,
        reason: "no IBs registered for this chapter",
      },
    };
  }

  // Name omitted: single-IB chapter returns that IB; multi-IB returns list.
  if (!input.name) {
    if (chapterIBs.length === 1) {
      return { ok: true, data: { ib: chapterIBs[0] } };
    }
    return {
      ok: true,
      data: {
        ibs: chapterIBs.map((ib) => ({ name: ib.name, one_liner: oneLiner(ib) })),
      },
    };
  }

  const hit = chapterIBs.find((ib) => ib.name === input.name);
  if (!hit) {
    return {
      ok: false,
      error: "ib_not_found",
      details: {
        chapter_id: input.chapter_id,
        requested_name: input.name,
        available: chapterIBs.map((ib) => ib.name),
      },
    };
  }
  return { ok: true, data: { ib: hit } };
}
