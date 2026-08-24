// JSON-RPC 2.0 envelope handling: parsing what a client sent us, and shaping what we send back.
//
// This module owns the envelope and nothing else. It does not know what MCP methods exist (that's
// server.ts) nor how the bytes arrived (that's transport.ts), which is what makes it directly
// testable without a Request or a live instance.
//
// Scope note: we implement the subset of JSON-RPC 2.0 that MCP actually uses. Batches are parsed
// because the wire format permits an array, but the spec's own guidance is that a server may reject
// them; we accept them and answer each element independently, which is strictly more permissive.

/** The only `jsonrpc` value we accept or emit. */
export const JSONRPC_VERSION = "2.0";

/** A JSON-RPC id. `null` is a valid id on the wire but is only ever used on error responses. */
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  /** Absent for notifications, which take no response. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** The standard JSON-RPC 2.0 error codes. MCP defines no codes of its own outside this range. */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcErrorCode =
    typeof JSON_RPC_ERROR_CODES[keyof typeof JSON_RPC_ERROR_CODES] | number;

/**
 * An error carrying a JSON-RPC code. Anything else thrown out of dispatch is reported as
 * `internalError` with its message -- deliberately, since every tool here runs against the caller's
 * own account and the messages the underlying API produces are written for that user.
 */
export class JsonRpcError extends Error {
  readonly code: JsonRpcErrorCode;
  readonly data?: unknown;

  constructor(code: JsonRpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }

  static invalidRequest(message: string, data?: unknown): JsonRpcError {
    return new JsonRpcError(JSON_RPC_ERROR_CODES.invalidRequest, message, data);
  }

  static methodNotFound(method: string): JsonRpcError {
    return new JsonRpcError(JSON_RPC_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): JsonRpcError {
    return new JsonRpcError(JSON_RPC_ERROR_CODES.invalidParams, message, data);
  }

  static internal(message: string, data?: unknown): JsonRpcError {
    return new JsonRpcError(JSON_RPC_ERROR_CODES.internalError, message, data);
  }
}

/** Coerces anything thrown during dispatch into the `error` member of a response. */
export function toJsonRpcErrorBody(error: unknown): JsonRpcFailure["error"] {
  if (error instanceof JsonRpcError) {
    return error.data === undefined
        ? { code: error.code, message: error.message }
        : { code: error.code, message: error.message, data: error.data };
  }
  let message = error instanceof Error ? error.message : String(error);
  return { code: JSON_RPC_ERROR_CODES.internalError, message };
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorResponse(id: JsonRpcId | null, error: unknown): JsonRpcFailure {
  return { jsonrpc: JSONRPC_VERSION, id, error: toJsonRpcErrorBody(error) };
}

/** What `parseJsonRpcPayload` produces for one element of the payload. */
export type ParsedMessage =
    | { ok: true; request: JsonRpcRequest }
    /** Structurally invalid. `id` is the id we could recover, if any, to address the error to. */
    | { ok: false; id: JsonRpcId | null; error: JsonRpcError };

export type ParsedPayload = {
  /** True when the payload was a JSON array (the response must be an array too). */
  batch: boolean;
  messages: ParsedMessage[];
};

function isJsonRpcId(value: unknown): value is JsonRpcId {
  // Fractional ids are legal JSON-RPC but nothing produces them, and letting them through would
  // make the id a poor map key. Integers and strings only.
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function parseOne(value: unknown): ParsedMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, id: null,
             error: JsonRpcError.invalidRequest("Request must be a JSON object.") };
  }
  let record = value as Record<string, unknown>;
  let id = isJsonRpcId(record.id) ? record.id : null;

  if (record.jsonrpc !== JSONRPC_VERSION) {
    return { ok: false, id,
             error: JsonRpcError.invalidRequest(`"jsonrpc" must be "${JSONRPC_VERSION}".`) };
  }
  if (typeof record.method !== "string") {
    return { ok: false, id, error: JsonRpcError.invalidRequest(`"method" must be a string.`) };
  }
  if ("id" in record && record.id !== null && id === null) {
    return { ok: false, id: null,
             error: JsonRpcError.invalidRequest(`"id" must be a string or an integer.`) };
  }
  if (record.params !== undefined &&
      (typeof record.params !== "object" || record.params === null)) {
    return { ok: false, id, error: JsonRpcError.invalidParams(`"params" must be an object or an array.`) };
  }

  // A response carries neither, so a message with `result`/`error` is a client bug worth naming.
  if ("result" in record || "error" in record) {
    return { ok: false, id,
             error: JsonRpcError.invalidRequest("This endpoint accepts requests, not responses.") };
  }

  let request: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, method: record.method };
  // A message with `id: null` is a notification as far as we're concerned: there is no id to
  // address a response to.
  if (id !== null) request.id = id;
  if (record.params !== undefined) request.params = record.params;
  return { ok: true, request };
}

/**
 * Parses a request body into individual JSON-RPC messages. Throws `JsonRpcError` only for problems
 * with the payload as a whole (unparseable JSON, an empty batch); per-message problems are reported
 * as failed `ParsedMessage`s so a batch's good elements still run.
 */
export function parseJsonRpcPayload(text: string): ParsedPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new JsonRpcError(JSON_RPC_ERROR_CODES.parseError,
        `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw JsonRpcError.invalidRequest("Batch must contain at least one request.");
    }
    return { batch: true, messages: payload.map(parseOne) };
  }
  return { batch: false, messages: [parseOne(payload)] };
}

/** True when the request expects a response (i.e. it isn't a notification). */
export function expectsResponse(request: JsonRpcRequest): request is JsonRpcRequest & { id: JsonRpcId } {
  return request.id !== undefined;
}
