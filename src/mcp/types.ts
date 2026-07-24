/**
 * Minimal MCP wire types we care about. We hand-roll over the JSON-RPC envelope
 * rather than pull in @modelcontextprotocol/sdk because that SDK targets Node
 * and bundles transport assumptions that do not fit the Workers runtime.
 *
 * MCP protocol reference: spec.modelcontextprotocol.io
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/**
 * Worker Env binding. Matches wrangler.toml.
 */
export interface Env {
  BUYERS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  SESSION_SECRET: string;
  // Shared secret carried in the registered /gumroad/license-sync URL
  // (?token=…). Optional: verify-before-store makes the endpoint safe
  // without it, but set it anyway (defense in depth).
  GUMROAD_SYNC_SECRET?: string;
}

/**
 * Shape every tool handler returns. Either a successful structured payload
 * (we wrap it as JSON content in the MCP envelope) or an error object the
 * caller can render.
 */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; details?: Record<string, unknown> };
