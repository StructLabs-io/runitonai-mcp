/**
 * Tool registry + dispatcher.
 *
 * Lists the tools the MCP server advertises (via tools/list) and routes
 * tools/call to the matching handler. Live tools call into ../tools/*.ts;
 * stubs route through ../tools/stubs.ts.
 *
 * Auth enforcement happens HERE. Gated tools (chapter prose) accept either:
 *   - `access_code` tool argument — the buyer's Gumroad license key. The
 *     primary path: it is the only credential every shipping MCP client can
 *     carry (the model passes it as an argument; no header plumbing needed).
 *   - `Authorization: Bearer <token>` header — power-user path (legacy
 *     tokens; no email-based minting surface exists anymore).
 * `activate` and `get_implementation_block` are keyless (IBs are public —
 * they ship in full in the open-source repo). Per-credential / per-IP rate
 * limits also live here.
 *
 * There is deliberately NO tool that accepts an email: the privacy claim
 * "you never give us your email" is enforced by the absence of any code
 * path that could receive one (2026-07-24 checker decision).
 */

import { lookupChapter } from "../tools/lookup_chapter.ts";
import { getImplementationBlock } from "../tools/get_implementation_block.ts";
import { activate } from "../tools/activate.ts";
import { stubResponse, STUBBED_TOOLS } from "../tools/stubs.ts";
import { checkAndIncrement } from "../rate_limit.ts";
import { extractBearerToken, verifyToken, sha256Hex } from "../auth.ts";
import { verifyAccessCode } from "../license.ts";
import type { Env, ToolDef, ToolResult } from "./types.ts";

// Keyless tools are rate-limited per IP; gated tools per credential.
const ACTIVATE_LIMIT_PER_HOUR = 30;
const IB_LIMIT_PER_HOUR = 60;
const CHAPTER_LIMIT_PER_HOUR = 60;

/**
 * Public tool catalogue. Returned by tools/list. The frontmatter shape and
 * input schemas are deliberately compact — MCP clients (and harness indexers
 * like Claude Code) need enough to know when to call but not so much that the
 * descriptors crowd out the SKILL.md description.
 */
export const TOOL_CATALOG: ToolDef[] = [
  {
    name: "activate",
    description:
      "Start here. Returns the Run It on AI companion's full operating instructions " +
      "(engagement modes, routing, voice rules, tool usage). Call this FIRST — before any " +
      "other tool — when the user says \"Activate Run It on AI\", mentions the Run It on AI " +
      "ebook, or asks for help choosing/deploying AI in their business. No authentication.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "lookup_chapter",
    description:
      "Fetch a full chapter or a named section by slug. Buyer-gated: pass the reader's " +
      "access_code (their Gumroad license key).",
    inputSchema: {
      type: "object",
      properties: {
        chapter_id: { type: "string", description: "Manuscript slug, e.g. how-ai-actually-works." },
        section: { type: "string", description: "Optional H2 section slug within the chapter." },
        access_code: {
          type: "string",
          description:
            "The reader's access code: the Gumroad license key from their Run It on AI receipt " +
            "(format XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX). Required unless the request carries " +
            "an Authorization: Bearer token. Once the reader has supplied it, pass it on every call.",
        },
      },
      required: ["chapter_id"],
    },
  },
  {
    name: "get_implementation_block",
    description:
      "Fetch a structured Implementation Block (reader_prompt, agent_notes, target_artifact) " +
      "by chapter and name. Free to call — no access code needed; the Implementation Blocks " +
      "are public (they also ship in the open-source server repo).",
    inputSchema: {
      type: "object",
      properties: {
        chapter_id: { type: "string" },
        name: { type: "string", description: "IB name, e.g. compounding-question. Omit to list IBs in chapter." },
      },
      required: ["chapter_id"],
    },
  },
  // Phase 2 + Phase 3 stubs. They appear in tools/list so callers can discover
  // them; calling them returns a structured not_implemented error.
  ...STUBBED_TOOLS.map((name) => ({
    name,
    description: `Stub — not implemented in Phase 1. See tool response 'phase' field.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  })),
];

/** Per-IP rate limit for keyless tools. Returns null when allowed. */
async function ipRateLimit(
  env: Env,
  headers: Headers,
  scope: string,
  limitPerHour: number,
): Promise<ToolResult | null> {
  const ip = headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkAndIncrement(env.RATE_LIMIT, scope, await sha256Hex(ip), limitPerHour);
  if (rl.allowed) return null;
  return {
    ok: false,
    error: "rate_limited",
    details: { limit_per_hour: rl.limit, retry_after_minutes: 60 },
  };
}

/**
 * Resolve the caller's credential for gated tools. Bearer header wins when
 * valid; otherwise the access_code argument is checked against the license
 * mirror / Gumroad. Returns the rate-limit key on success, or a ToolResult
 * error to bubble up.
 */
async function authenticate(
  env: Env,
  headers: Headers,
  accessCode: unknown,
): Promise<{ ok: true; rateKey: string } | { ok: false; result: ToolResult }> {
  let bearerReason: string | null = null;
  const raw = extractBearerToken(headers);
  if (raw) {
    const verified = await verifyToken(env.SESSION_SECRET, raw);
    if (verified.ok) return { ok: true, rateKey: verified.tokenHash };
    bearerReason = verified.reason;
  }

  if (typeof accessCode === "string" && accessCode.trim() !== "") {
    const lic = await verifyAccessCode(env, accessCode);
    if (lic.ok) return { ok: true, rateKey: `lk:${lic.keyHash}` };
    if (lic.reason === "rate_limited") {
      return {
        ok: false,
        result: {
          ok: false,
          error: "rate_limited",
          details: { scope: "license_verify", retry_after_minutes: 60 },
        },
      };
    }
    return {
      ok: false,
      result: {
        ok: false,
        error: "unauthorized",
        details: {
          reason: lic.reason,
          hint:
            lic.reason === "verify_unavailable"
              ? "License verification is temporarily unavailable. Retry in a few minutes."
              : "The access code did not match a valid purchase. It is the license key on the Gumroad receipt for Run It on AI.",
        },
      },
    };
  }

  return {
    ok: false,
    result: {
      ok: false,
      error: "unauthorized",
      details: {
        reason: bearerReason ?? "missing_credentials",
        hint:
          "Pass access_code as a tool argument — the Gumroad license key from the reader's " +
          "Run It on AI receipt (format XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX).",
      },
    },
  };
}

/**
 * Dispatch a tool call. Handles auth + rate limit + handler routing.
 *
 * The MCP "tools/call" envelope:
 *   { name: "<tool>", arguments: { ... } }
 *
 * Returns a ToolResult that the caller (sse.ts or the HTTP mirror in worker.ts)
 * wraps in the appropriate transport envelope.
 */
export async function dispatchToolCall(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  headers: Headers,
): Promise<ToolResult> {
  // Keyless tools: per-IP rate limit, no credential.
  if (toolName === "activate") {
    const limited = await ipRateLimit(env, headers, "activate", ACTIVATE_LIMIT_PER_HOUR);
    if (limited) return limited;
    return activate();
  }
  if (toolName === "get_implementation_block") {
    const limited = await ipRateLimit(env, headers, "get_ib", IB_LIMIT_PER_HOUR);
    if (limited) return limited;
    // Tolerate a stray access_code argument from older clients; it is unused.
    const { access_code: _ignored, ...ibArgs } = args as Record<string, unknown> & {
      access_code?: unknown;
    };
    return getImplementationBlock(ibArgs as { chapter_id: string; name?: string });
  }

  // Stubs and unknown names resolve before the auth gate so callers get an
  // accurate error (not a misleading `unauthorized` for a tool that does
  // not exist). Stubs carry no content, so keyless stub calls leak nothing.
  if (STUBBED_TOOLS.includes(toolName)) {
    return stubResponse(toolName);
  }
  if (toolName !== "lookup_chapter") {
    return { ok: false, error: "unknown_tool", details: { tool: toolName } };
  }

  // Gated tool: access_code argument or bearer header.
  const { access_code, ...toolArgs } = args as Record<string, unknown> & {
    access_code?: unknown;
  };
  const auth = await authenticate(env, headers, access_code);
  if (!auth.ok) return auth.result;

  const rl = await checkAndIncrement(
    env.RATE_LIMIT,
    "lookup_chapter",
    auth.rateKey,
    CHAPTER_LIMIT_PER_HOUR,
  );
  if (!rl.allowed) {
    return {
      ok: false,
      error: "rate_limited",
      details: { limit_per_hour: rl.limit, retry_after_minutes: 60 },
    };
  }
  return lookupChapter(toolArgs as { chapter_id: string; section?: string });
}
