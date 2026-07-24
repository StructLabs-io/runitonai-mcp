/**
 * lookup_chapter — returns full chapter content, or a named section.
 *
 * Auth: bearer token required.
 * Rate limit: 60 requests per token per hour.
 *
 * Phase 1 v0.14.0 chapters don't yet carry slug anchors (those land in v0.15.0
 * per plan §9 Change 2). Section lookup is best-effort: we slugify each H2
 * heading and match against the requested `section`. On no-match, we return
 * the whole chapter plus { section_not_found: true } so the caller can decide.
 */

// Note: no `with { type: "json" }` import attribute — esbuild (wrangler's
// bundler) on the current Workers runtime does not yet accept it. TypeScript
// resolves the import via `resolveJsonModule: true` in tsconfig.json, and
// esbuild bundles the JSON as a module.
import chaptersData from "../data/chapters.json";
import type { ToolResult } from "../mcp/types.ts";

interface ChapterRow {
  chapter_id: string;
  file: string;
  title: string;
  content: string;
}

const CHAPTERS = chaptersData as ChapterRow[];

export interface LookupChapterInput {
  chapter_id: string;
  section?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pull a section by H2 heading slug. Returns the content from the matched
 * heading down to the next H2 heading or EOF, exclusive of the next heading.
 */
function extractSection(content: string, sectionSlug: string): string | null {
  const lines = content.split("\n");
  const target = slugify(sectionSlug);
  let inSection = false;
  let buf: string[] = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const slug = slugify(h2[1] ?? "");
      if (slug === target) {
        inSection = true;
        buf = [line];
        continue;
      }
      if (inSection) break;
    }
    if (inSection) buf.push(line);
  }
  return buf.length > 0 ? buf.join("\n").trim() : null;
}

export async function lookupChapter(input: LookupChapterInput): Promise<ToolResult> {
  if (!input.chapter_id) {
    return { ok: false, error: "invalid_input", details: { reason: "chapter_id is required" } };
  }
  const chapter = CHAPTERS.find((c) => c.chapter_id === input.chapter_id);
  if (!chapter) {
    return {
      ok: false,
      error: "chapter_not_found",
      details: {
        chapter_id: input.chapter_id,
        available: CHAPTERS.map((c) => c.chapter_id),
      },
    };
  }

  if (input.section) {
    const sectionContent = extractSection(chapter.content, input.section);
    if (sectionContent) {
      return {
        ok: true,
        data: {
          chapter_id: chapter.chapter_id,
          title: chapter.title,
          section: { slug: slugify(input.section), content: sectionContent },
        },
      };
    }
    return {
      ok: true,
      data: {
        chapter_id: chapter.chapter_id,
        title: chapter.title,
        content: chapter.content,
        section_not_found: true,
        requested_section: input.section,
      },
    };
  }

  return {
    ok: true,
    data: {
      chapter_id: chapter.chapter_id,
      title: chapter.title,
      content: chapter.content,
    },
  };
}
