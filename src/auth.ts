/**
 * Auth helpers.
 *
 * Mirrors the cookie-signing approach used by site/src/worker.ts so MCP-issued
 * tokens and ebook-Worker-issued cookies share a verification surface. Both
 * Workers use HMAC-SHA256 over a JSON payload, keyed by the SESSION_SECRET set
 * via `wrangler secret put`.
 *
 * Token shape (base64url-encoded):
 *
 *   <base64url(JSON.stringify(payload))>.<base64url(hmac-sha256(payload))>
 *
 * Payload:
 *
 *   { sub: <sha256(email)>, iat: <epoch_ms>, exp: <epoch_ms>, src: "mcp" }
 *
 * The ebook Worker may need a small change later to recognise tokens with
 * src="mcp" alongside its existing src="cookie" tokens. For Phase 1 the MCP
 * Worker only verifies its own tokens.
 */

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface TokenPayload {
  sub: string;       // sha256 hex of normalized email
  iat: number;       // epoch ms issued-at
  exp: number;       // epoch ms expiry
  src: "mcp";        // origin tag, distinguishes from ebook Worker's "cookie"
}

// ---------------------------------------------------------------------------
// Base64URL helpers (Workers do not ship a base64url codec)
// ---------------------------------------------------------------------------

function bufToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

export async function sha256(input: string): Promise<string> {
  return sha256Hex(input);
}

// ---------------------------------------------------------------------------
// HMAC signing
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

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bufToBase64Url(sig);
}

async function hmacVerify(secret: string, data: string, sig: string): Promise<boolean> {
  const key = await importHmacKey(secret);
  return crypto.subtle.verify("HMAC", key, base64UrlToBytes(sig), new TextEncoder().encode(data));
}

// ---------------------------------------------------------------------------
// Token mint + verify
// ---------------------------------------------------------------------------

export async function mintToken(secret: string, emailHash: string): Promise<{
  token: string;
  expires_at: string;
}> {
  const now = Date.now();
  const payload: TokenPayload = {
    sub: emailHash,
    iat: now,
    exp: now + TOKEN_TTL_MS,
    src: "mcp",
  };
  const encoded = bufToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, encoded);
  return {
    token: `${encoded}.${sig}`,
    expires_at: new Date(payload.exp).toISOString(),
  };
}

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
