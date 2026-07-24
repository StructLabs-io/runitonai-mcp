/**
 * list_book_index — discovery surface for valid chapter ids.
 *
 * Returns every entry in chapters.json (front matter, chapters, appendices)
 * with its title, plus the Implementation Block names per chapter. Exists so
 * a model that doesn't know the id vocabulary can find it instead of
 * guessing wrong ("the content tool only supports chapters, not appendices"
 * — observed in live GPT testing 2026-07-24, asking for Appendix B).
 *
 * Auth: none — ids and titles are catalog metadata, not book content.
 * Rate limit: per-IP, enforced in the dispatcher.
 */

// See note in lookup_chapter.ts on the missing `with { type: "json" }`
// import attribute — same reason here.
import chaptersData from "../data/chapters.json";
import ibsData from "../data/ibs.json";
import type { ToolResult } from "../mcp/types.ts";

interface ChapterRow {
  chapter_id: string;
  file: string;
  title: string;
  content: string;
}

interface IBRow {
  chapter_id: string;
  name: string;
}

// chapters.json is file-sorted (book order) by the extraction script.
const INDEX = (chaptersData as ChapterRow[]).map((c) => ({
  chapter_id: c.chapter_id,
  // Some front-matter files carry no frontmatter title; the id is the
  // load-bearing field, so fall back to it rather than shipping "".
  title: c.title || c.chapter_id,
  implementation_blocks: (ibsData as IBRow[])
    .filter((ib) => ib.chapter_id === c.chapter_id)
    .map((ib) => ib.name),
}));

export function listBookIndex(): ToolResult {
  return {
    ok: true,
    data: {
      chapters: INDEX,
      usage_hint:
        "Every chapter_id here works with lookup_chapter / getChapter (access code " +
        "required) — including the appendices. Entries with implementation_blocks " +
        "also work with get_implementation_block (no access code).",
    },
  };
}
