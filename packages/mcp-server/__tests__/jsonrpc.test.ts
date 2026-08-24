import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERROR_CODES,
  JsonRpcError,
  errorResponse,
  expectsResponse,
  parseJsonRpcPayload,
  successResponse,
  toJsonRpcErrorBody,
} from "../src/jsonrpc.js";

describe("parseJsonRpcPayload", () => {
  it("parses a single request", () => {
    let payload = parseJsonRpcPayload(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(payload.batch).toBe(false);
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]).toEqual(
        { ok: true, request: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  });

  it("parses a notification as a request with no id", () => {
    let payload = parseJsonRpcPayload(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    let message = payload.messages[0]!;
    expect(message.ok).toBe(true);
    if (!message.ok) throw new Error("unreachable");
    expect(expectsResponse(message.request)).toBe(false);
  });

  it("treats an explicit null id as a notification", () => {
    // There is nowhere to address a response to `id: null`, so the message can only be a
    // notification -- and reporting an error for it would have nowhere to go either.
    let payload = parseJsonRpcPayload(JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }));
    let message = payload.messages[0]!;
    if (!message.ok) throw new Error("expected a parsed request");
    expect(expectsResponse(message.request)).toBe(false);
  });

  it("keeps a batch's good elements when one is malformed", () => {
    let payload = parseJsonRpcPayload(JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "1.0", id: 2, method: "ping" },
    ]));
    expect(payload.batch).toBe(true);
    expect(payload.messages[0]!.ok).toBe(true);
    let bad = payload.messages[1]!;
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    // The id is recovered so the error can be addressed back to the right element.
    expect(bad.id).toBe(2);
    expect(bad.error.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
  });

  it("rejects a non-integer id rather than guessing", () => {
    let payload = parseJsonRpcPayload(JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "ping" }));
    let message = payload.messages[0]!;
    expect(message.ok).toBe(false);
  });

  it("rejects a response sent to a request endpoint", () => {
    let payload = parseJsonRpcPayload(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", result: {} }));
    let message = payload.messages[0]!;
    if (message.ok) throw new Error("expected a rejection");
    expect(message.error.message).toContain("requests, not responses");
  });

  it("throws parseError for a body that isn't JSON", () => {
    expect(() => parseJsonRpcPayload("{nope")).toThrowError(
        expect.objectContaining({ code: JSON_RPC_ERROR_CODES.parseError }));
  });

  it("throws invalidRequest for an empty batch", () => {
    expect(() => parseJsonRpcPayload("[]")).toThrowError(
        expect.objectContaining({ code: JSON_RPC_ERROR_CODES.invalidRequest }));
  });

  it("rejects scalar params", () => {
    let payload = parseJsonRpcPayload(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: 3 }));
    let message = payload.messages[0]!;
    if (message.ok) throw new Error("expected a rejection");
    expect(message.error.code).toBe(JSON_RPC_ERROR_CODES.invalidParams);
  });
});

describe("responses", () => {
  it("shapes a success", () => {
    expect(successResponse(7, { ok: true }))
        .toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  it("preserves a JsonRpcError's code and data", () => {
    let error = new JsonRpcError(JSON_RPC_ERROR_CODES.invalidParams, "bad", { field: "x" });
    expect(errorResponse("a", error)).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: JSON_RPC_ERROR_CODES.invalidParams, message: "bad", data: { field: "x" } },
    });
  });

  it("reports an unexpected throw as internalError", () => {
    expect(toJsonRpcErrorBody(new TypeError("boom")))
        .toEqual({ code: JSON_RPC_ERROR_CODES.internalError, message: "boom" });
  });

  it("omits data when there is none", () => {
    let body = toJsonRpcErrorBody(JsonRpcError.methodNotFound("nope"));
    expect("data" in body).toBe(false);
    expect(body.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
  });
});
