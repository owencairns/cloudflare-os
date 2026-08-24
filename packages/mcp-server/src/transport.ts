// The Streamable HTTP transport, stateless mode.
//
// MCP's Streamable HTTP transport has two shapes. The stateful one issues an `Mcp-Session-Id` on
// initialize, keeps per-session state, and offers a long-lived `GET` stream for server-initiated
// messages. The stateless one -- what this implements -- treats every POST as self-contained: no
// session id, no server-initiated traffic, no stream to resume. That is the right shape here
// because the server holds nothing between requests: each call authenticates, does its work through
// the same capability objects the UI uses, and returns. It is also the shape a Worker can serve
// without a Durable Object.
//
// Consequences, all deliberate: `GET /mcp` is 405 (no SSE stream to open), `DELETE` is 405 (no
// session to end), and an `Mcp-Session-Id` on a request is ignored rather than rejected -- a client
// that carried one over from another server is better served by working than by a protocol error.

import {
  JsonRpcError,
  JSON_RPC_ERROR_CODES,
  errorResponse,
  expectsResponse,
  parseJsonRpcPayload,
  successResponse,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import { MCP_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type McpServer } from "./server.js";

/** Bodies larger than this are rejected unread. Tool arguments carry file contents, so it is not small. */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const JSON_CONTENT_TYPE = "application/json";

/**
 * Headers every response carries. MCP clients are frequently browser-hosted, and the endpoint is
 * safe for cross-origin use because it authorizes in-band (a bearer credential, never a cookie) --
 * the same reasoning that lets the Cap'n Web endpoint next door allow `*`.
 *
 * `Access-Control-Expose-Headers` matters more than it looks: a browser client cannot read the
 * `WWW-Authenticate` header that starts the OAuth flow unless it is exposed here, so leaving it out
 * would break discovery from exactly the clients that need it most.
 */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
  };
}

/** Builds a response with the transport's standard headers, plus any extras. */
export function mcpResponse(
    body: BodyInit | null, init: { status: number; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init.status,
    headers: {
      ...corsHeaders(),
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...init.headers,
    },
  });
}

/** A JSON body with the transport's standard headers. */
export function jsonResponse(
    value: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return mcpResponse(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: { "Content-Type": JSON_CONTENT_TYPE, ...init?.headers },
  });
}

/** A transport-level (not JSON-RPC-level) refusal: plain text, so a human reading logs can tell. */
function transportError(status: number, message: string,
                        headers?: Record<string, string>): Response {
  return mcpResponse(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function acceptsJson(req: Request): boolean {
  let accept = req.headers.get("Accept");
  // Absent Accept means "anything"; several MCP clients omit it. Only an explicit list that
  // excludes JSON is a problem.
  if (!accept) return true;
  return accept.split(",").some((part: string) => {
    let media = part.split(";")[0]!.trim().toLowerCase();
    return media === JSON_CONTENT_TYPE || media === "application/*" || media === "*/*";
  });
}

function isJsonContentType(req: Request): boolean {
  let contentType = req.headers.get("Content-Type");
  if (!contentType) return false;
  return contentType.split(";")[0]!.trim().toLowerCase() === JSON_CONTENT_TYPE;
}

/**
 * Handles one HTTP request against an MCP server.
 *
 * `ctx` is whatever the host resolved for this request -- for the workshop backend, the
 * authenticated principal plus the capability objects its tools run against. The transport never
 * inspects it. Authentication happens *before* this call, so that an unauthenticated request can be
 * answered with the `WWW-Authenticate` challenge that starts OAuth discovery without the transport
 * needing to know what an authorization server is.
 */
export async function handleStreamableHttp<Ctx>(
    req: Request, server: McpServer<Ctx>, ctx: Ctx): Promise<Response> {
  if (req.method === "OPTIONS") {
    return mcpResponse(null, { status: 204 });
  }

  if (req.method !== "POST") {
    // Stateless mode offers no server-initiated stream and holds no session, so GET and DELETE --
    // the two other verbs the transport defines -- have nothing to do here.
    return transportError(405,
        "This MCP endpoint is stateless: it accepts POST only (no SSE stream, no session).",
        { "Allow": "POST, OPTIONS" });
  }

  if (!acceptsJson(req)) {
    return transportError(406, `This endpoint responds with ${JSON_CONTENT_TYPE}.`);
  }
  if (!isJsonContentType(req)) {
    return transportError(415, `Request body must be ${JSON_CONTENT_TYPE}.`);
  }

  let declaredVersion = req.headers.get("MCP-Protocol-Version");
  if (declaredVersion !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(declaredVersion)) {
    return transportError(400,
        `Unsupported MCP-Protocol-Version "${declaredVersion}". ` +
        `Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`);
  }

  let contentLength = Number(req.headers.get("Content-Length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) {
    return transportError(413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
  }

  let text: string;
  try {
    text = await req.text();
  } catch (error) {
    return transportError(400,
        `Could not read request body: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Re-check against the actual body: Content-Length is absent on chunked requests.
  if (text.length > MAX_REQUEST_BODY_BYTES) {
    return transportError(413, `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.`);
  }

  let payload;
  try {
    payload = parseJsonRpcPayload(text);
  } catch (error) {
    // A payload that isn't addressable to any id still gets a JSON-RPC error object (id `null`),
    // which is what the spec asks for and what clients report usefully.
    return jsonResponse(errorResponse(null, error), { status: 400 });
  }

  let responses: JsonRpcResponse[] = [];
  for (let message of payload.messages) {
    if (!message.ok) {
      // A malformed notification (no recoverable id) is dropped: there is nowhere to send the error.
      if (message.id !== null) responses.push(errorResponse(message.id, message.error));
      continue;
    }
    let request = message.request;
    try {
      let result = await server.dispatch(request, ctx);
      if (expectsResponse(request)) responses.push(successResponse(request.id, result));
    } catch (error) {
      if (expectsResponse(request)) {
        responses.push(errorResponse(request.id, error));
      }
      // A notification that threw has no response channel; dropping it is the only option the
      // protocol leaves. (Nothing here throws for a notification: dispatch returns undefined.)
    }
  }

  if (responses.length === 0) {
    // Everything in the payload was a notification. The spec's answer is 202 with no body.
    return mcpResponse(null, { status: 202 });
  }

  return jsonResponse(payload.batch ? responses : responses[0]);
}

/** Re-exported so hosts building error responses don't need a second import. */
export { JsonRpcError, JSON_RPC_ERROR_CODES };
