/**
 * Tool registry + dispatcher.
 *
 * Lists the tools the MCP server advertises (via tools/list) and routes
 * tools/call to the matching handler. Live tools call into ../tools/*.ts;
 * stubs route through ../tools/stubs.ts.
 *
 * Auth enforcement happens HERE. Content tools accept either:
 *   - `access_code` tool argument — the buyer's Gumroad license key. The
 *     primary path: it is the only credential every shipping MCP client can
 *     carry (the model passes it as an argument; no header plumbing needed).
 *   - `Authorization: Bearer <token>` header — power-user path, token minted
 *     by verify_buyer (email fallback).
 * Per-credential rate limits also live here.
 */

import { verifyBuyer } from "../tools/verify_buyer.ts";
import { lookupChapter } from "../tools/lookup_chapter.ts";
import { getImplementationBlock } from "../tools/get_implementation_block.ts";
import { activate } from "../tools/activate.ts";
import { stubResponse, STUBBED_TOOLS } from "../tools/stubs.ts";
import { checkAndIncrement } from "../rate_limit.ts";
import { extractBearerToken, verifyToken, sha256Hex } from "../auth.ts";
import { verifyAccessCode } from "../license.ts";
import type { Env, ToolDef, ToolResult } from "./types.ts";

interface LiveToolMeta {
  rate_limit_per_hour: number;
}

const LIVE_TOOL_META: Record<string, LiveToolMeta> = {
  lookup_chapter: { rate_limit_per_hour: 60 },
  get_implementation_block: { rate_limit_per_hour: 60 },
};

// Unauthenticated `activate` calls are rate-limited per IP.
const ACTIVATE_LIMIT_PER_HOUR = 30;

// Shared schema fragment for the access_code argument on content tools.
const ACCESS_CODE_PROP = {
  type: "string",
  description:
    "The reader's access code: the Gumroad license key from their Run It on AI receipt " +
    "(format XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX). Required unless the request carries " +
    "an Authorization: Bearer token. Once the reader has supplied it, pass it on every call.",
};

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
        access_code: ACCESS_CODE_PROP,
      },
      required: ["chapter_id"],
    },
  },
  {
    name: "get_implementation_block",
    description:
      "Fetch a structured Implementation Block (reader_prompt, agent_notes, target_artifact) " +
      "by chapter and name. Buyer-gated: pass the reader's access_code (their Gumroad license key).",
    inputSchema: {
      type: "object",
      properties: {
        chapter_id: { type: "string" },
        name: { type: "string", description: "IB name, e.g. compounding-question. Omit to list IBs in chapter." },
        access_code: ACCESS_CODE_PROP,
      },
      required: ["chapter_id"],
    },
  },
  {
    name: "verify_buyer",
    description:
      "Fallback gate for readers who cannot find their license key: exchange the purchase " +
      "email for a 90-day bearer token (must then be sent as an Authorization header — " +
      "power-user path). Prefer passing access_code to content tools directly.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string", description: "The email used to buy the ebook." } },
      required: ["email"],
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

/**
 * Resolve the caller's credential. Bearer header wins when valid; otherwise
 * the access_code argument is checked against the license mirror / Gumroad.
 * Returns the rate-limit key on success, or a ToolResult error to bubble up.
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
          "Pass access_code (the Gumroad license key from the reader's receipt) as a tool " +
          "argument, or send a bearer token from verify_buyer in the Authorization header.",
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
  // Unauthenticated tools.
  if (toolName === "verify_buyer") {
    return verifyBuyer(args as { email: string }, env);
  }
  if (toolName === "activate") {
    const ip = headers.get("CF-Connecting-IP") ?? "unknown";
    const rl = await checkAndIncrement(
      env.RATE_LIMIT,
      "activate",
      await sha256Hex(ip),
      ACTIVATE_LIMIT_PER_HOUR,
    );
    if (!rl.allowed) {
      return {
        ok: false,
        error: "rate_limited",
        details: { limit_per_hour: rl.limit, retry_after_minutes: 60 },
      };
    }
    return activate();
  }

  // Auth gate: access_code argument or bearer header.
  const { access_code, ...toolArgs } = args as Record<string, unknown> & {
    access_code?: unknown;
  };
  const auth = await authenticate(env, headers, access_code);
  if (!auth.ok) return auth.result;

  // Per-credential rate limit on live tools.
  const meta = LIVE_TOOL_META[toolName];
  if (meta) {
    const rl = await checkAndIncrement(
      env.RATE_LIMIT,
      toolName,
      auth.rateKey,
      meta.rate_limit_per_hour,
    );
    if (!rl.allowed) {
      return {
        ok: false,
        error: "rate_limited",
        details: { limit_per_hour: rl.limit, retry_after_minutes: 60 },
      };
    }
  }

  switch (toolName) {
    case "lookup_chapter":
      return lookupChapter(toolArgs as { chapter_id: string; section?: string });
    case "get_implementation_block":
      return getImplementationBlock(toolArgs as { chapter_id: string; name?: string });
    default:
      if (STUBBED_TOOLS.includes(toolName)) {
        return stubResponse(toolName);
      }
      return { ok: false, error: "unknown_tool", details: { tool: toolName } };
  }
}
