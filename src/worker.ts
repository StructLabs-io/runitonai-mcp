/**
 * Cloudflare Worker — Run It on AI MCP server (mcp.runitonai.com).
 *
 * Exposes:
 *
 *   POST /mcp                       MCP Streamable HTTP transport (2025-03-26
 *                                   spec). Single JSON-RPC endpoint. This is
 *                                   the path Claude Code uses with
 *                                   `claude mcp add --transport http`.
 *   GET  /sse                       Legacy MCP SSE event stream. Emits an
 *                                   `endpoint` event pointing the client at
 *                                   POST /messages?sessionId=…
 *   POST /messages                  Legacy SSE message channel (one-shot
 *                                   JSON-RPC; response returned inline rather
 *                                   than over the long-lived stream — works
 *                                   for Claude Code's SSE client, which polls
 *                                   for the POST result).
 *   POST /v1/verify_buyer           HTTP mirror: { email }      -> token
 *   POST /v1/tools/call             HTTP mirror: JSON-RPC tools/call envelope
 *   GET  /v1/tools/list             HTTP mirror: tools/list envelope
 *   GET  /openapi.yaml              OpenAPI 3.1 doc for the /v1 mirror (this
 *                                   is what a ChatGPT Custom GPT imports)
 *   POST /gumroad/license-sync      Gumroad resource-subscription consumer —
 *                                   mirrors license keys into BUYERS KV as
 *                                   sales happen. Separate from (and never
 *                                   touching) the site Worker's Ping URL.
 *   GET  /healthz                   simple healthcheck
 *
 * The HTTP mirror exists so harnesses without MCP support (e.g. custom GPTs,
 * see plan §7) can reach the same surface. Phase 1 ships these specced; the
 * full OpenAPI document lands in Phase 3 when ChatGPT path activates.
 *
 * Bindings (wrangler.toml):
 *   BUYERS         KV namespace — shared with site/ Worker
 *   RATE_LIMIT     KV namespace — per-token / per-email counters
 *
 * Secrets (wrangler secret put):
 *   SESSION_SECRET — HMAC-SHA256 key. MUST match the site/ Worker so tokens
 *                    issued here verify there and vice versa.
 */

import type { Env, JsonRpcRequest } from "./mcp/types.ts";
import { TOOL_CATALOG, dispatchToolCall } from "./mcp/tools.ts";
import { openSseStream, handleSsePost, handleJsonRpc } from "./mcp/sse.ts";
import { verifyBuyer } from "./tools/verify_buyer.ts";
import { mirrorLicenseEvent } from "./license.ts";
import { checkAndIncrement } from "./rate_limit.ts";
import { sha256Hex } from "./auth.ts";
import openapiYaml from "../openapi-v1.yaml";

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- healthcheck ---------------------------------------------------------
    if (url.pathname === "/healthz") {
      return json({ ok: true, server: "runitonai-mcp", version: "0.2.0" });
    }

    // --- OpenAPI document ----------------------------------------------------
    // Stable path for ChatGPT Custom GPT Actions imports (and anyone auditing
    // the HTTP surface). Bundled from openapi-v1.yaml at build time.
    if (url.pathname === "/openapi.yaml" && request.method === "GET") {
      return new Response(openapiYaml, {
        status: 200,
        headers: { "Content-Type": "application/yaml; charset=utf-8", ...CORS_HEADERS },
      });
    }

    // --- Gumroad resource-subscription consumer ------------------------------
    // Mirrors license keys into BUYERS KV as sales happen (and revokes on
    // refund/dispute). Registered via Gumroad's resource_subscriptions API
    // with ?token=<GUMROAD_SYNC_SECRET>. This is a NEW consumer: the existing
    // Gumroad Ping URL and its site-Worker consumer are deliberately untouched.
    if (url.pathname === "/gumroad/license-sync" && request.method === "POST") {
      return handleLicenseSync(request, env, url);
    }

    // --- MCP Streamable HTTP (2025-03-26 spec) ------------------------------
    // This is the modern transport Claude Code uses with
    // `claude mcp add --transport http <name> <url>`. A POST carries the
    // JSON-RPC envelope and the response is returned inline as application/json.
    if (url.pathname === "/mcp") {
      if (request.method === "POST") {
        return handleStreamableHttp(request, env);
      }
      if (request.method === "GET") {
        // Spec allows GET to open a server-initiated SSE stream. We don't push
        // anything from the server in Phase 1, so a 405 is honest; some clients
        // probe with GET, in which case an empty SSE stream is friendlier.
        return openSseStream();
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, GET", ...CORS_HEADERS },
      });
    }

    // --- Legacy MCP SSE (pre-2025-03-26 transport) --------------------------
    // GET /sse opens the event stream and emits `endpoint`; the client posts
    // its JSON-RPC requests to that endpoint (here, /messages?sessionId=…).
    // Kept for clients still configured with `--transport sse`.
    if (url.pathname === "/sse" || url.pathname === "/mcp/sse") {
      if (request.method === "GET") {
        const sessionId = crypto.randomUUID();
        const endpointPath = `/messages?sessionId=${sessionId}`;
        return openSseStream(endpointPath);
      }
      // Some legacy clients POST to /sse with the JSON-RPC envelope rather
      // than to the /messages endpoint emitted by the GET stream. Accept it.
      if (request.method === "POST") {
        return handleSsePost(request, env);
      }
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    if (url.pathname === "/messages" && request.method === "POST") {
      return handleSsePost(request, env);
    }

    // --- HTTP mirror: verify_buyer -----------------------------------------
    if (url.pathname === "/v1/verify_buyer" && request.method === "POST") {
      let body: { email?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      const result = await verifyBuyer({ email: body.email ?? "" }, env);
      if (result.ok) return json(result.data);
      return json({ error: result.error, ...result.details }, { status: 400 });
    }

    // --- HTTP mirror: tools/list -------------------------------------------
    if (url.pathname === "/v1/tools/list" && request.method === "GET") {
      return json({ tools: TOOL_CATALOG });
    }

    // --- HTTP mirror: tools/call -------------------------------------------
    if (url.pathname === "/v1/tools/call" && request.method === "POST") {
      let body: JsonRpcRequest;
      try {
        body = (await request.json()) as JsonRpcRequest;
      } catch {
        return json({ error: "invalid_json" }, { status: 400 });
      }
      // Accept either the JSON-RPC envelope or a bare {name, arguments} body.
      const isJsonRpc = body && body.jsonrpc === "2.0";
      if (isJsonRpc) {
        const rpc = await handleJsonRpc(body, env, request.headers);
        return json(rpc);
      }
      const flat = body as unknown as { name?: string; arguments?: Record<string, unknown> };
      if (!flat.name) return json({ error: "name is required" }, { status: 400 });
      const result = await dispatchToolCall(flat.name, flat.arguments ?? {}, env, request.headers);
      if (result.ok) return json(result.data);
      return json({ error: result.error, ...result.details }, { status: 400 });
    }

    // --- root ----------------------------------------------------------------
    if (url.pathname === "/") {
      return json({
        server: "runitonai-book",
        version: "0.2.0",
        source: "https://github.com/StructLabs/runitonai-mcp",
        transport: {
          streamable_http: "POST /mcp",
          sse_legacy: "GET /sse + POST /messages",
        },
        http_mirror: {
          openapi: "GET /openapi.yaml",
          verify_buyer: "POST /v1/verify_buyer",
          tools_list: "GET /v1/tools/list",
          tools_call: "POST /v1/tools/call",
        },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

/**
 * Streamable HTTP handler. Accepts a JSON-RPC request body, dispatches it,
 * returns the response inline as application/json.
 *
 * Per spec the client MUST include `Accept: application/json, text/event-stream`.
 * We are tolerant — a missing Accept just falls through to JSON, which is what
 * we'd return anyway for a synchronous tool call.
 */
async function handleStreamableHttp(request: Request, env: Env): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
      { status: 400 },
    );
  }
  const response = await handleJsonRpc(body, env, request.headers);
  return json(response);
}

/**
 * POST /gumroad/license-sync — Gumroad resource-subscription consumer.
 *
 * Layered defenses (resource-subscription POSTs carry no signature):
 *   1. per-IP rate limit,
 *   2. shared secret in the registered URL (?token=…) when
 *      GUMROAD_SYNC_SECRET is set,
 *   3. verify-before-store inside mirrorLicenseEvent — a license key is
 *      confirmed against Gumroad's verify API before it is mirrored, so a
 *      forged POST cannot plant a key Gumroad does not recognize.
 *
 * Responses are always 200-family for processed payloads (Gumroad retries on
 * failure codes); the body says what happened for log forensics.
 */
async function handleLicenseSync(request: Request, env: Env, url: URL): Promise<Response> {
  console.log(
    `license-sync received: ip=${request.headers.get("CF-Connecting-IP") || "?"} ua=${JSON.stringify(request.headers.get("User-Agent") || "")}`,
  );

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const rl = await checkAndIncrement(env.RATE_LIMIT, "license_sync", await sha256Hex(ip), 120);
  if (!rl.allowed) {
    return new Response("rate limited", { status: 429, headers: CORS_HEADERS });
  }

  if (env.GUMROAD_SYNC_SECRET) {
    const provided = url.searchParams.get("token") ?? "";
    if (!(await timingSafeEqualStr(provided, env.GUMROAD_SYNC_SECRET))) {
      return new Response("forbidden", { status: 403, headers: CORS_HEADERS });
    }
  }

  // Gumroad posts application/x-www-form-urlencoded; accept JSON too.
  let params: URLSearchParams;
  try {
    const ct = request.headers.get("Content-Type") || "";
    if (ct.includes("application/json")) {
      const j = (await request.json()) as Record<string, unknown>;
      params = new URLSearchParams(
        Object.entries(j).map(([k, v]) => [k, String(v)] as [string, string]),
      );
    } else {
      params = new URLSearchParams(await request.text());
    }
  } catch {
    return new Response("bad request", { status: 400, headers: CORS_HEADERS });
  }

  const outcome = await mirrorLicenseEvent(env, params);
  console.log(`license-sync outcome: ${outcome}`);
  return new Response(outcome, { status: 200, headers: CORS_HEADERS });
}

/**
 * Constant-time string comparison via HMAC equality — compares digests of
 * both inputs under a random per-call key so length and content leak nothing.
 */
async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const key = (await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )) as CryptoKey;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
