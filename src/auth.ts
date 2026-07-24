/**
 * Auth helpers: bearer-token VERIFICATION plus shared hashing utilities.
 *
 * This Worker no longer mints tokens — the email-gate tool (verify_buyer)
 * was removed 2026-07-24 so that no code path here can receive an email.
 * verifyToken remains so previously issued 90-day tokens keep working for
 * power users until they expire; the access code (Gumroad license key,
 * src/license.ts) is the credential going forward.
 *
 * Token shape (base64url-encoded), HMAC-SHA256 keyed by SESSION_SECRET:
 *
 *   <base64url(JSON.stringify(payload))>.<base64url(hmac-sha256(payload))>
 */

export interface TokenPayload {
  sub: string;       // opaque subject hash (legacy tokens: sha256 of email)
  iat: number;       // epoch ms issued-at
  exp: number;       // epoch ms expiry
  src: "mcp";        // origin tag, distinguishes from ebook Worker's "cookie"
}

// ---------------------------------------------------------------------------
// Base64URL helpers (Workers do not ship a base64url codec)
// ---------------------------------------------------------------------------

function base64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  return crypto.subtle.verify("HMAC", key, base64UrlToBytes(sig), new TextEncoder().encode(data));
}

// ---------------------------------------------------------------------------
// Token verify (minting removed with the email gate, 2026-07-24)
// ---------------------------------------------------------------------------

export interface VerifiedToken {
  ok: true;
  payload: TokenPayload;
  tokenHash: string;  // sha256 of the token string, used for per-token rate limit keys
}

export interface InvalidToken {
  ok: false;
  reason: "missing" | "malformed" | "bad_signature" | "expired";
}

export async function verifyToken(
  secret: string,
  raw: string | null,
): Promise<VerifiedToken | InvalidToken> {
  if (!raw) return { ok: false, reason: "missing" };
  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [encoded, sig] = parts as [string, string];
  if (!encoded || !sig) return { ok: false, reason: "malformed" };
  const valid = await hmacVerify(secret, encoded, sig);
  if (!valid) return { ok: false, reason: "bad_signature" };
  let payload: TokenPayload;
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(encoded));
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  const tokenHash = await sha256Hex(raw);
  return { ok: true, payload, tokenHash };
}

export function extractBearerToken(headers: Headers): string | null {
  const auth = headers.get("Authorization") ?? headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
