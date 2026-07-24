/**
 * SSE transport for the MCP server.
 *
 * Workers don't support the synchronous-loop SSE pattern most MCP server libs
 * assume — Workers buffer Response bodies unless you stream via ReadableStream.
 * We hand-roll the SSE framing (event: type\ndata: json\n\n).
 *
 * MCP over SSE: the server holds the SSE connection open and writes
 * JSON-RPC-2.0 messages to it. The client posts JSON-RPC requests to a
 * companion POST endpoint, which we route through this same handler via the
 * `message` channel.
 *
 * For Phase 1 we ship a minimal SSE handler that:
 *   - On GET /sse: opens an SSE stream, writes a "connected" event with a
 *     session id, and idles. The client posts JSON-RPC to POST /sse with the
 *     session id and we deliver the response over the open stream.
 *
 * This is the simplest shape that gets Claude Code's MCP client past handshake.
 * Phase 2 may swap in a more standard implementation if/when an
 * MCP-Workers-compatible lib lands.
 */

import { dispatchToolCall, TOOL_CATALOG } from "./tools.ts";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
} from "./types.ts";
import type { Env, JsonRpcRequest, JsonRpcResponse } from "./types.ts";

const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

function sseFrame(event: string, data: unknown): string {
  // The MCP SSE `endpoint` event's data is a bare URL string, not JSON.
  // Other events (JSON-RPC messages) carry JSON payloads.
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/**
 * Handle MCP JSON-RPC methods. Returns the response object (without the SSE
 * framing).
 */
export async function handleJsonRpc(
  req: JsonRpcRequest,
  env: Env,
  headers: Headers,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case "initialize": {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "runitonai-book", version: "0.1.0" },
          },
        };
      }
      case "tools/list": {
        return { jsonrpc: "2.0", id, result: { tools: TOOL_CATALOG } };
      }
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!params.name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: JSONRPC_INVALID_REQUEST, message: "tools/call requires a name" },
          };
        }
        const result = await dispatchToolCall(params.name, params.arguments ?? {}, env, headers);
        if (result.ok) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
              isError: false,
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: result.error, ...result.details }, null, 2) }],
            isError: true,
          },
        };
      }
      case "ping": {
        return { jsonrpc: "2.0", id, result: {} };
      }
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JSONRPC_INTERNAL_ERROR,
        message: err instanceof Error ? err.message : "internal error",
      },
    };
  }
}

/**
 * GET /sse — open the long-lived event stream. Per the MCP HTTP+SSE spec
 * (pre-2025-03-26), the server emits exactly one `endpoint` event whose data
 * payload is the path the client should POST its JSON-RPC requests to. The
 * client opens that POST, sends the request, and the response comes back
 * inline (since Workers cannot deliver across requests without a Durable
 * Object).
 *
 * Pass the `endpointPath` (e.g. `/messages?sessionId=…`) from worker.ts so
 * the sessionId can be threaded into the URL. If omitted, falls back to a
 * generic `/messages` — fine for clients that ignore the path detail.
 *
 * Modern clients use Streamable HTTP at POST /mcp; this path is preserved for
 * backwards compatibility with anyone still configured `--transport sse`.
 */
export function openSseStream(endpointPath: string = "/messages"): Response {
  const stream = new ReadableStream({
    start(controller) {
      // Required first event for the pre-2025-03-26 SSE transport.
      controller.enqueue(
        new TextEncoder().encode(sseFrame("endpoint", endpointPath)),
      );
      // Periodic keepalive every 25s so intermediate proxies don't drop the
      // connection. Workers run for at most ~30s by default — production
      // deployment may want to bump this via [unsafe] settings.
      const interval = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(`: keepalive\n\n`));
        } catch {
          clearInterval(interval);
        }
      }, 25_000);
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * POST /sse — accept a JSON-RPC request, dispatch it, and return the response
 * inline as JSON. Most MCP clients use a separate POST for the request leg
 * even when the response leg is SSE; for Phase 1 we just return JSON here.
 */
export async function handleSsePost(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, JSONRPC_INVALID_REQUEST, "request body is not valid JSON");
  }
  const response = await handleJsonRpc(body, env, request.headers);
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  const body: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
