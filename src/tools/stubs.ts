/**
 * Stubbed Phase 2 / Phase 3 tools.
 *
 * Same auth + rate-limit surface as the live tools, but the handler returns
 * a structured "not_implemented" response so discovery via list_book_index
 * (when wired in Phase 2) and naive callers see a clear signal, not a 404.
 */

import type { ToolResult } from "../mcp/types.ts";

interface StubMeta {
  phase: "2" | "3";
  notes: string;
}

const STUB_METADATA: Record<string, StubMeta> = {
  find_section: { phase: "2", notes: "Semantic / keyword search across the ebook." },
  find_playbook: { phase: "2", notes: "Match a task description to a Chapter 7 playbook." },
  get_playbook: { phase: "2", notes: "Fetch a playbook by id." },
  list_book_index: {
    phase: "2",
    notes: "Discovery surface: all chapters, sections, playbooks, IBs.",
  },
  report_telemetry: {
    phase: "3",
    notes: "Aggregate event stream. Wired to Cloudflare Analytics Engine.",
  },
  get_session_history: {
    phase: "3",
    notes: "Read per-reader session breadcrumbs. Wired to Cloudflare D1.",
  },
  save_session_state: {
    phase: "3",
    notes: "Write a session breadcrumb. Wired to Cloudflare D1.",
  },
  forget_session_history: {
    phase: "3",
    notes: "Wipe all breadcrumbs for the current token. Wired to Cloudflare D1.",
  },
};

export function stubResponse(tool: string): ToolResult {
  const meta = STUB_METADATA[tool];
  if (!meta) {
    return { ok: false, error: "unknown_tool", details: { tool } };
  }
  return {
    ok: false,
    error: "not_implemented",
    details: { tool, phase: meta.phase, notes: meta.notes },
  };
}

export const STUBBED_TOOLS = Object.keys(STUB_METADATA);
