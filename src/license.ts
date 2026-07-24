/**
 * License-key auth ("access code").
 *
 * The buyer's credential is their Gumroad license key — shown on the receipt
 * and the product's post-purchase Content page. It identifies a purchase, not
 * a person, so no PII changes hands (decision memo 2026-07-24 §4).
 *
 * Verification order:
 *
 *   1. KV cache — BUYERS key `license:<sha256(normalized key)>`. Written by
 *      the resource-subscription mirror (pre-warm at sale time) and by
 *      positive live verifies. Every write carries a 24h TTL, so Gumroad
 *      stays the source of truth: a key disabled or refunded on Gumroad
 *      stops working here within a day even if no webhook fires.
 *   2. Live verify — POST api.gumroad.com/v2/licenses/verify with
 *      increment_uses_count=false. FAIL CLOSED on success:false, on
 *      refunded/chargebacked/disputed purchase flags, and on Gumroad being
 *      unreachable. Live verifies are rate-limited per key hash so this
 *      Worker cannot be used to brute-force license keys.
 *
 * Nothing plaintext is stored: KV keys are sha256 of the normalized license
 * key, mirroring the hashed-email convention in BUYERS.
 */

import { sha256Hex } from "./auth.ts";
import { checkAndIncrement } from "./rate_limit.ts";
import type { Env } from "./mcp/types.ts";

const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

// Stable opaque Gumroad product id for the ebook. Same value as
// BOOK_PRODUCT_ID in site/src/worker.ts — the licenses/verify API and the
// resource-subscription payloads both identify the product by it.
export const BOOK_PRODUCT_ID = "Q63DERDJWVQf8NHNciZ8lA==";
// Product permalink, matched as a fallback in webhook payloads (see the
// 2026-07-04 incident note in site/src/worker.ts: payloads vary in which
// identifier they carry).
export const BOOK_PERMALINK = "eypmtx";

const LICENSE_KV_PREFIX = "license:";
// Email-hash -> plaintext license key mapping, written by the resource-
// subscription mirror and read by the site Worker's "Find my access code"
// page (site/src/worker.ts uses the same literal prefix — keep in sync).
// License keys are purchase identifiers, not PII; the email side stays
// hashed, so no plaintext email is ever stored.
export const EMAIL_LICENSE_KV_PREFIX = "lk-email:";
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h — revocation propagation bound
// Live Gumroad verifies per key hash per hour. Cache hits don't count, so a
// legitimate reader spends at most ~1/day; this only throttles guessing.
const LIVE_VERIFY_LIMIT_PER_HOUR = 10;

// Gumroad keys look like XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX. Accept some
// slack (future formats) but refuse obvious garbage before it reaches KV or
// the Gumroad API.
const LICENSE_KEY_SHAPE = /^[A-Z0-9][A-Z0-9-]{14,62}[A-Z0-9]$/;

interface LicenseRecord {
  status: "active";
  source: string; // "gumroad_verify" | "resource_subscription:<sale_id>"
  cached_at: string;
}

export function normalizeLicenseKey(raw: string): string {
  return raw.trim().toUpperCase();
}

async function licenseKvKey(normalizedKey: string): Promise<string> {
  return LICENSE_KV_PREFIX + (await sha256Hex(normalizedKey));
}

export type AccessCodeResult =
  | { ok: true; keyHash: string }
  | {
      ok: false;
      reason:
        | "malformed"
        | "invalid_license"
        | "license_revoked"
        | "rate_limited"
        | "verify_unavailable";
    };

/**
 * Call Gumroad's public license verify API. Pure network step — no KV.
 */
async function gumroadVerify(
  licenseKey: string,
): Promise<{ status: "active" } | { status: "invalid" | "revoked" | "unavailable" }> {
  let res: Response;
  try {
    res = await fetch(GUMROAD_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        product_id: BOOK_PRODUCT_ID,
        license_key: licenseKey,
        increment_uses_count: "false",
      }),
    });
  } catch {
    return { status: "unavailable" };
  }
  // Gumroad answers 404 with success:false for unknown/disabled keys.
  if (res.status === 404) return { status: "invalid" };
  if (!res.ok) return { status: "unavailable" };

  let body: {
    success?: boolean;
    purchase?: { refunded?: boolean; chargebacked?: boolean; disputed?: boolean };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { status: "unavailable" };
  }
  if (body.success !== true) return { status: "invalid" };
  const p = body.purchase ?? {};
  if (p.refunded === true || p.chargebacked === true || p.disputed === true) {
    return { status: "revoked" };
  }
  return { status: "active" };
}

/**
 * Verify an access code (Gumroad license key). KV cache first, live verify
 * on miss. Positive results are cached with TTL; negatives never are.
 */
export async function verifyAccessCode(env: Env, raw: string): Promise<AccessCodeResult> {
  const normalized = normalizeLicenseKey(raw);
  if (!LICENSE_KEY_SHAPE.test(normalized)) {
    return { ok: false, reason: "malformed" };
  }
  const keyHash = await sha256Hex(normalized);

  const cached = await env.BUYERS.get(await licenseKvKey(normalized));
  if (cached !== null) {
    return { ok: true, keyHash };
  }

  // Throttle live verifies per key hash before touching Gumroad.
  const rl = await checkAndIncrement(
    env.RATE_LIMIT,
    "license_verify",
    keyHash,
    LIVE_VERIFY_LIMIT_PER_HOUR,
  );
  if (!rl.allowed) {
    return { ok: false, reason: "rate_limited" };
  }

  const verdict = await gumroadVerify(normalized);
  if (verdict.status === "active") {
    await cacheLicense(env, normalized, "gumroad_verify");
    return { ok: true, keyHash };
  }
  if (verdict.status === "revoked") return { ok: false, reason: "license_revoked" };
  if (verdict.status === "unavailable") return { ok: false, reason: "verify_unavailable" };
  return { ok: false, reason: "invalid_license" };
}

async function cacheLicense(env: Env, normalizedKey: string, source: string): Promise<void> {
  const record: LicenseRecord = {
    status: "active",
    source,
    cached_at: new Date().toISOString(),
  };
  await env.BUYERS.put(await licenseKvKey(normalizedKey), JSON.stringify(record), {
    expirationTtl: CACHE_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Resource-subscription mirror (POST /gumroad/license-sync)
// ---------------------------------------------------------------------------

/**
 * Consume one Gumroad resource-subscription event (sale / refund / dispute).
 *
 * The Ping URL and its consumer on the site Worker are untouched — this is a
 * separate consumer registered via Gumroad's resource_subscriptions API.
 *
 * Resource-subscription POSTs carry no signature, so a forged POST could try
 * to plant an attacker-chosen license key. Two defenses:
 *   - the registered URL carries a shared secret (?token=…, checked in
 *     worker.ts when GUMROAD_SYNC_SECRET is set), and
 *   - verify-before-store: the license key in a sale event is confirmed
 *     against Gumroad's verify API before it is mirrored. A key Gumroad
 *     does not recognize is never written, secret or no secret.
 *
 * Returns a short outcome string for the HTTP response / logs.
 */
export async function mirrorLicenseEvent(env: Env, params: URLSearchParams): Promise<string> {
  // Only this product. Same any-identifier matching as the site Worker's
  // ping consumer — payloads vary in which field they carry. FAIL CLOSED.
  const permalink = params.get("product_permalink") || params.get("permalink") || "";
  const shortId = params.get("short_product_id") || "";
  const productId = params.get("product_id") || "";
  const isThisProduct =
    permalink.includes(BOOK_PERMALINK) ||
    shortId === BOOK_PERMALINK ||
    productId === BOOK_PRODUCT_ID;
  if (!isThisProduct) {
    return "ignored (other/unknown product)";
  }

  const rawKey = params.get("license_key") || "";
  if (!rawKey) {
    return "ignored (no license_key in payload)";
  }
  const normalized = normalizeLicenseKey(rawKey);
  if (!LICENSE_KEY_SHAPE.test(normalized)) {
    return "ignored (malformed license_key)";
  }

  // Buyer email, when the payload carries one — feeds the email->key mapping
  // behind the reader's "Find my access code" page.
  const email = (params.get("email") || "").trim().toLowerCase();
  const emailMapKey =
    email && email.includes("@") ? EMAIL_LICENSE_KV_PREFIX + (await sha256Hex(email)) : null;

  // Refund / dispute / cancellation events revoke: drop the cache entry so
  // the next use falls through to live verify, which fails closed on the
  // refunded/chargebacked flags. The email->key mapping goes with it.
  const resourceName = params.get("resource_name") || "";
  const isRevocation =
    params.get("refunded") === "true" ||
    params.get("disputed") === "true" ||
    resourceName === "refund" ||
    resourceName === "dispute" ||
    resourceName === "cancellation";
  if (isRevocation) {
    await env.BUYERS.delete(await licenseKvKey(normalized));
    if (emailMapKey) await env.BUYERS.delete(emailMapKey);
    return "ok (license revoked)";
  }

  // Sale event: verify-before-store.
  const verdict = await gumroadVerify(normalized);
  if (verdict.status !== "active") {
    return `ignored (gumroad verify: ${verdict.status})`;
  }
  const saleId = params.get("sale_id") || params.get("order_number") || "";
  await cacheLicense(
    env,
    normalized,
    saleId ? `resource_subscription:${saleId}` : "resource_subscription",
  );
  // Permanent (no TTL): the mapping is display data for the buyer's own
  // account page, revoked explicitly on refund events above.
  if (emailMapKey) {
    await env.BUYERS.put(
      emailMapKey,
      JSON.stringify({
        license_key: normalized,
        sale_id: saleId || undefined,
        source: "resource_subscription",
        cached_at: new Date().toISOString(),
      }),
    );
  }
  return "ok (license mirrored)";
}
