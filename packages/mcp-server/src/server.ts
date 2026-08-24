// MCP method dispatch: `initialize`, `ping`, `tools/list`, `tools/call`, and the notifications a
// client sends alongside them.
//
// The server is a pure function of (request, context): it holds the tool table and nothing else.
// All per-request state -- who is calling, what they may do, which capability objects their calls
// run against -- lives in the `Ctx` the transport hands in, which is what lets the same server
// object serve every request in a stateless deployment.

import {
  InitializeRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type InitializeResultSchema,
  type ListToolsResultSchema,
} from "@modelcontextprotocol/core";
import type { z } from "zod";
import { JsonRpcError, type JsonRpcRequest } from "./jsonrpc.js";
import {
  toCallToolResult,
  toolDescriptor,
  validateToolArguments,
  ToolError,
  errorResult,
  type CallToolResult,
  type ToolDefinition,
} from "./tool.js";

export type InitializeResult = z.infer<typeof InitializeResultSchema>;
export type ListToolsResult = z.infer<typeof ListToolsResultSchema>;

/**
 * The protocol revision this server implements, and the one it advertises when a client asks for
 * something else. Kept in step with `MCP_PROTOCOL_VERSION` in `@gadgets/mcp-shared/client` (the
 * client half of the same wire), which a unit test asserts rather than importing: this package is
 * deliberately free of the Workers-runtime types that module carries.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Revisions we will speak if a client asks for one. `2025-03-26` differs from the current revision
 * only in ways that don't reach a tools-only server, so accepting it costs nothing and lets older
 * clients connect.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] =
    [MCP_PROTOCOL_VERSION, "2025-03-26"];

export type McpServerOptions<Ctx> = {
  /** Server identity, reported in `initialize`. */
  name: string;
  version: string;
  title?: string;
  /** Free-text guidance a client may show its model alongside the tool list. */
  instructions?: string;
  tools: readonly ToolDefinition<Ctx>[];

  /**
   * ==> THE SCOPE SEAM <== Called once per `tools/call`, before the handler runs, and once per tool
   * when building `tools/list`. Return `undefined` to allow, or a reason string to refuse -- a
   * refusal from `tools/call` becomes an `isError` result naming the reason, and a refusal during
   * `tools/list` hides the tool.
   *
   * Today's host passes a function that consults `ToolDefinition.scopes` against the scopes on the
   * authenticated principal, which are `null` (meaning unscoped) for every credential the current
   * auth path issues. When OAuth-issued credentials start carrying the scopes a user approved, this
   * is the one function that has to learn to read them; nothing in the tool table or the dispatch
   * path below changes.
   */
  authorize?: (tool: ToolDefinition<Ctx>, ctx: Ctx) => string | undefined;
};

export class McpServer<Ctx> {
  readonly #options: McpServerOptions<Ctx>;
  readonly #tools: Map<string, ToolDefinition<Ctx>>;

  constructor(options: McpServerOptions<Ctx>) {
    this.#options = options;
    this.#tools = new Map();
    for (let tool of options.tools) {
      if (this.#tools.has(tool.name)) {
        throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      }
      this.#tools.set(tool.name, tool);
    }
  }

  /** The tools this context may see, in declaration order. */
  listTools(ctx: Ctx): ListToolsResult {
    let tools = [...this.#tools.values()]
        .filter(tool => this.#options.authorize?.(tool, ctx) === undefined)
        .map(toolDescriptor);
    return { tools };
  }

  #initialize(request: JsonRpcRequest): InitializeResult {
    let parsed = InitializeRequestSchema.safeParse({
      method: "initialize", params: request.params ?? {},
    });
    if (!parsed.success) {
      throw JsonRpcError.invalidParams(
          `Invalid initialize params: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    let requested = parsed.data.params.protocolVersion;
    // Per the spec: honour the client's revision when we speak it, otherwise answer with ours and
    // let the client decide whether it can proceed.
    let protocolVersion =
        SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;

    let result: InitializeResult = {
      protocolVersion,
      // No resources, prompts, or completions in v1. `listChanged: false` is the honest answer for
      // a stateless server: it has no channel on which to push a change notification.
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.#options.name,
        version: this.#options.version,
        ...(this.#options.title === undefined ? {} : { title: this.#options.title }),
      },
    };
    if (this.#options.instructions !== undefined) {
      result.instructions = this.#options.instructions;
    }
    return result;
  }

  async #callTool(request: JsonRpcRequest, ctx: Ctx): Promise<CallToolResult> {
    let parsed = CallToolRequestSchema.safeParse({
      method: "tools/call", params: request.params ?? {},
    });
    if (!parsed.success) {
      throw JsonRpcError.invalidParams(
          `Invalid tools/call params: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    let { name, arguments: rawArgs } = parsed.data.params;

    let tool = this.#tools.get(name);
    // A tool that exists but is out of scope is reported the same way as one that doesn't, so a
    // caller can't probe the scope boundary by name. The refusal reason is still returned below for
    // a tool the caller can see -- this branch is only reached when it can't.
    if (!tool) throw JsonRpcError.invalidParams(`Unknown tool: ${name}`);

    let refusal = this.#options.authorize?.(tool, ctx);
    if (refusal !== undefined) return errorResult(refusal);

    let args = validateToolArguments(name, tool.inputSchema, rawArgs);

    try {
      return toCallToolResult(await tool.handler(args, ctx));
    } catch (error) {
      // A `ToolError` is a failure the caller should see and can act on, so it comes back as a
      // failed *result* rather than a protocol error: MCP clients feed those to their model, which
      // is the right place for "that workspace doesn't exist" or "the agent is busy". Everything
      // else propagates as a JSON-RPC error.
      if (error instanceof ToolError) return errorResult(error.message);
      if (error instanceof JsonRpcError) throw error;
      throw JsonRpcError.internal(
          error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Dispatches one request. Notifications (no `id`) return `undefined`; everything else returns the
   * `result` member for the response. Throws `JsonRpcError` for protocol-level failures.
   */
  async dispatch(request: JsonRpcRequest, ctx: Ctx): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return this.#initialize(request);

      case "ping":
        // The spec's keepalive: an empty result, no params of interest.
        return {};

      case "tools/list": {
        let parsed = ListToolsRequestSchema.safeParse({
          method: "tools/list", params: request.params ?? {},
        });
        if (!parsed.success) {
          throw JsonRpcError.invalidParams(
              `Invalid tools/list params: ${parsed.error.issues[0]?.message ?? "unknown"}`);
        }
        // The tool table is small and fixed, so the whole list fits one page and no `nextCursor` is
        // returned. A cursor the client didn't get from us is a client bug, and saying so beats
        // silently handing back page one again.
        if (parsed.data.params?.cursor !== undefined) {
          throw JsonRpcError.invalidParams("This server returns its whole tool list in one page.");
        }
        return this.listTools(ctx);
      }

      case "tools/call":
        return await this.#callTool(request, ctx);

      // Client-to-server notifications. Nothing here is stateful, so they are accepted and dropped
      // -- but they must not 404: a client that gets an error for `notifications/initialized`
      // reports the connection as broken.
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        if (request.id !== undefined) {
          throw JsonRpcError.invalidRequest(`"${request.method}" is a notification and takes no id.`);
        }
        return undefined;

      default:
        throw JsonRpcError.methodNotFound(request.method);
    }
  }
}
