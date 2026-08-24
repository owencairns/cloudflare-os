// Tool definitions and their results.
//
// `defineTool` mirrors the shape of the workshop agent's own `defineTool` (workshop-backend
// src/agent.ts): a name, a human description, a parameter schema, and a handler that receives
// validated arguments. The difference is the schema language -- the agent describes parameters with
// TypeBox because pi validates against it, while MCP puts a raw JSON Schema object on the wire, so
// that is what a tool declares here.

import type { CallToolResultSchema, ToolSchema } from "@modelcontextprotocol/core";
import type { z } from "zod";
import { JSON_RPC_ERROR_CODES, JsonRpcError } from "./jsonrpc.js";

/**
 * A `tools/list` entry, exactly as the spec defines it.
 *
 * @modelcontextprotocol/core publishes the spec as Zod schemas rather than as types, so the wire
 * shapes here are inferred from them. Inference rather than hand-written interfaces is the point: a
 * spec bump that changes a shape becomes a type error in this package instead of a wire mismatch in
 * the field.
 */
export type Tool = z.infer<typeof ToolSchema>;

/** A `tools/call` result: content blocks plus the `isError` flag. Inferred, as above. */
export type CallToolResult = z.infer<typeof CallToolResultSchema>;

/**
 * The subset of JSON Schema a tool may declare for its arguments. Kept narrow on purpose: it is
 * exactly what `validateToolArguments` below enforces, so a schema can't promise a client something
 * the server doesn't check.
 */
export type ToolPropertySchema = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  /** For `type: "array"`. Element shape, if constrained. */
  items?: ToolPropertySchema;
  /** For `type: "string"`. Permitted values. */
  enum?: readonly string[];
  default?: unknown;
};

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, ToolPropertySchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

/**
 * A tool's handler failed in a way the *caller* should see and can act on -- a workspace that
 * doesn't exist, a chat that's busy. Reported as a `CallToolResult` with `isError: true`, which is
 * how MCP distinguishes "the tool ran and failed" from "the protocol call failed"; a client feeds
 * the former back to its model, which is what we want for anything the model could retry or route
 * around.
 */
export class ToolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolError";
  }
}

/** Handlers return either a ready-made result or a string, which is wrapped as one text block. */
export type ToolOutput = CallToolResult | string;

export type ToolHandler<Ctx> =
    (args: Record<string, unknown>, ctx: Ctx) => Promise<ToolOutput> | ToolOutput;

export type ToolDefinition<Ctx> = {
  name: string;
  /** Human-readable label, shown by clients that render one. */
  title?: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Scopes a credential must carry to invoke this tool.
   *
   * ==> THE SCOPE SEAM <== Nothing in this package interprets these; the host decides, via
   * `McpServerOptions.authorize`. Declared here rather than in the host's tool table so that the
   * requirement travels with the tool and `tools/list` can filter on it once scopes exist.
   */
  scopes?: readonly string[];
  handler: ToolHandler<Ctx>;
};

/**
 * Identity function that pins a tool's parts together at the definition site, the way agent.ts's
 * `defineTool` does. It exists for inference and for the one obvious place to hang the contract.
 */
export function defineTool<Ctx>(def: ToolDefinition<Ctx>): ToolDefinition<Ctx> {
  return def;
}

/** Wraps text as the single content block of a successful result. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Serializes a value as pretty JSON in one text block -- the default shape for our tools. */
export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, jsonReplacer, 2));
}

/** A tool-level failure: the call succeeded, the tool reports it could not do the thing. */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// Dates cross the workshop API as Date objects; JSON.stringify already renders them ISO-8601, but
// Maps and Sets would silently become `{}`, and bigints throw. Handle them rather than lose data.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** Normalizes whatever a handler returned into a `CallToolResult`. */
export function toCallToolResult(output: ToolOutput): CallToolResult {
  return typeof output === "string" ? textResult(output) : output;
}

/** The `tools/list` entry for a definition. */
export function toolDescriptor<Ctx>(tool: ToolDefinition<Ctx>): Tool {
  let descriptor: Tool = {
    name: tool.name,
    description: tool.description,
    // The wire type is an open JSON Schema object; ours is a checked subset of it.
    inputSchema: tool.inputSchema as unknown as Tool["inputSchema"],
  };
  if (tool.title !== undefined) descriptor.title = tool.title;
  return descriptor;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function checkValue(path: string, value: unknown, schema: ToolPropertySchema): void {
  let actual = typeOf(value);
  let expected = schema.type;

  if (expected === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw JsonRpcError.invalidParams(`"${path}" must be an integer (got ${actual}).`);
    }
    return;
  }
  if (expected === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw JsonRpcError.invalidParams(`"${path}" must be a finite number (got ${actual}).`);
    }
    return;
  }
  if (actual !== expected) {
    throw JsonRpcError.invalidParams(`"${path}" must be of type ${expected} (got ${actual}).`);
  }
  if (expected === "string" && schema.enum && !schema.enum.includes(value as string)) {
    throw JsonRpcError.invalidParams(
        `"${path}" must be one of: ${schema.enum.join(", ")} (got ${JSON.stringify(value)}).`);
  }
  if (expected === "array" && schema.items) {
    (value as unknown[]).forEach((item, i) => checkValue(`${path}[${i}]`, item, schema.items!));
  }
}

/**
 * Validates `tools/call` arguments against a tool's declared schema, returning them with declared
 * defaults filled in. Throws `JsonRpcError.invalidParams` on any violation.
 *
 * Deliberately shallow: it enforces required-ness, the declared type of each top-level property,
 * string enums, and array element types. Anything past that (nested object shapes, formats,
 * numeric bounds) is the handler's business -- the handlers here hand their arguments straight to
 * an API that validates them properly, so a second half-good validator in front would only
 * disagree with the real one.
 */
export function validateToolArguments(
    toolName: string, schema: ToolInputSchema, rawArgs: unknown): Record<string, unknown> {
  if (rawArgs === undefined || rawArgs === null) rawArgs = {};
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw JsonRpcError.invalidParams(`"arguments" for ${toolName} must be an object.`);
  }
  let args = { ...(rawArgs as Record<string, unknown>) };

  if (schema.additionalProperties === false) {
    let unknownKeys = Object.keys(args).filter(key => !(key in schema.properties));
    if (unknownKeys.length > 0) {
      throw JsonRpcError.invalidParams(
          `${toolName} has no parameter named ${unknownKeys.map(k => `"${k}"`).join(", ")}.`);
    }
  }

  for (let name of schema.required ?? []) {
    if (args[name] === undefined) {
      throw JsonRpcError.invalidParams(`${toolName} requires "${name}".`);
    }
  }

  for (let [name, property] of Object.entries(schema.properties)) {
    if (args[name] === undefined) {
      // `null` is how several clients spell "not provided" for an optional argument; treat it that
      // way rather than failing a type check the caller can't see the point of.
      delete args[name];
      if (property.default !== undefined) args[name] = property.default;
      continue;
    }
    if (args[name] === null && !(schema.required ?? []).includes(name)) {
      delete args[name];
      if (property.default !== undefined) args[name] = property.default;
      continue;
    }
    checkValue(name, args[name], property);
  }

  return args;
}

/** Convenience for hosts: the code a "tool doesn't exist" rejection uses. */
export const TOOL_NOT_FOUND_CODE = JSON_RPC_ERROR_CODES.invalidParams;
