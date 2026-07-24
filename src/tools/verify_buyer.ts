/**
 * verify_buyer — the email gate entry point.
 *
 * Checks the provided email against the shared BUYERS KV (sha256-hashed
 * lookup) and, on hit, mints a 90-day signed session token.
 *
 * Auth: none (this IS the auth entry point).
 * Rate limit: 5 requests per email per hour.
 */

import { mintToken, normalizeEmail, sha256Hex } from "../auth.ts";
import { checkAndIncrement } from "../rate_limit.ts";
import type { Env, ToolResult } from "../mcp/types.ts";

export interface VerifyBuyerInput {
  email: string;
}

export async function verifyBuyer(input: VerifyBuyerInput, env: Env): Promise<ToolResult> {
  if (!input.email || typeof input.email !== "string") {
    return { ok: false, error: "invalid_input", details: { reason: "email is required" } };
  }

  const normalized = normalizeEmail(input.email);
  const emailHash = await sha256Hex(normalized);

  // Per-email rate limit.
  const rl = await checkAndIncrement(env.RATE_LIMIT, "verify_buyer", emailHash, 5);
  if (!rl.allowed) {
    return {
      ok: false,
      error: "rate_limited",
      details: { limit_per_hour: rl.limit, retry_after_minutes: 60 },
    };
  }

  // The site Worker stores hashed emails as KV keys with a "source tag" value.
  // See site/src/worker.ts. Presence of the key == buyer.
  const source = await env.BUYERS.get(emailHash);
  if (source === null) {
    return { ok: false, error: "not_found" };
  }

  const minted = await mintToken(env.SESSION_SECRET, emailHash);
  return {
    ok: true,
    data: {
      token: minted.token,
      expires_at: minted.expires_at,
      source,
    },
  };
}
