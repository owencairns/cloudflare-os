import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSON_RPC_ERROR_CODES, JsonRpcError, type JsonRpcRequest } from "../src/jsonrpc.js";
import {
  MCP_PROTOCOL_VERSION,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../src/server.js";
import { ToolError, defineTool, jsonResult, validateToolArguments } from "../src/tool.js";

type Ctx = { scopes: readonly string[] | null };

const echo = defineTool<Ctx>({
  name: "echo",
  description: "Echoes its argument.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      times: { type: "integer", default: 1 },
      mode: { type: "string", enum: ["loud", "quiet"] },
    },
    required: ["text"],
    additionalProperties: false,
  },
  handler: (args) => (args.text as string).repeat(args.times as number),
});

const explode = defineTool<Ctx>({
  name: "explode",
  description: "Always fails.",
  inputSchema: { type: "object", properties: {} },
  handler: () => { throw new ToolError("the workspace is busy"); },
});

const crash = defineTool<Ctx>({
  name: "crash",
  description: "Fails unexpectedly.",
  inputSchema: { type: "object", properties: {} },
  handler: () => { throw new TypeError("undefined is not a function"); },
});

const privileged = defineTool<Ctx>({
  name: "privileged",
  description: "Needs a scope.",
  inputSchema: { type: "object", properties: {} },
  scopes: ["admin"],
  handler: () => jsonResult({ ok: true }),
});

function makeServer(): McpServer<Ctx> {
  return new McpServer<Ctx>({
    name: "test-server",
    version: "0.0.1",
    instructions: "Be brief.",
    tools: [echo, explode, crash, privileged],
    // The same shape the real host uses: null scopes mean unscoped.
    authorize: (tool, ctx) => {
      if (ctx.scopes === null) return undefined;
      let missing = (tool.scopes ?? []).filter(scope => !ctx.scopes!.includes(scope));
      return missing.length === 0 ? undefined : `missing ${missing.join(", ")}`;
    },
  });
}

const UNSCOPED: Ctx = { scopes: null };

function request(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

describe("protocol version", () => {
  it("matches the version the client half of the wire speaks", () => {
    // mcp-shared/src/client.ts is the MCP *client* this instance uses to talk to other servers.
    // Serving a different revision than we speak would be a bug we'd only find in the field, but
    // importing that module here would drag the Workers runtime types into a package that is
    // deliberately free of them -- so the constant is compared as source text instead.
    let source = readFileSync(
        fileURLToPath(new URL("../../mcp-shared/src/client.ts", import.meta.url)), "utf8");
    let match = /MCP_PROTOCOL_VERSION\s*=\s*"([^"]+)"/.exec(source);
    expect(match?.[1]).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe("initialize", () => {
  it("advertises tools and echoes a supported protocol version", async () => {
    let result = await makeServer().dispatch(request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1" },
    }), UNSCOPED) as Record<string, any>;

    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities.tools).toEqual({ listChanged: false });
    expect(result.serverInfo).toMatchObject({ name: "test-server", version: "0.0.1" });
    expect(result.instructions).toBe("Be brief.");
  });

  it("honours an older revision it still speaks", async () => {
    let older = SUPPORTED_PROTOCOL_VERSIONS.find(v => v !== MCP_PROTOCOL_VERSION)!;
    let result = await makeServer().dispatch(request("initialize", {
      protocolVersion: older, capabilities: {}, clientInfo: { name: "c", version: "1" },
    }), UNSCOPED) as Record<string, any>;
    expect(result.protocolVersion).toBe(older);
  });

  it("counter-offers its own revision when the client asks for one it doesn't speak", async () => {
    let result = await makeServer().dispatch(request("initialize", {
      protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "c", version: "1" },
    }), UNSCOPED) as Record<string, any>;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("rejects params that aren't an initialize request", async () => {
    await expect(makeServer().dispatch(request("initialize", { capabilities: {} }), UNSCOPED))
        .rejects.toMatchObject({ code: JSON_RPC_ERROR_CODES.invalidParams });
  });
});

describe("tools/list", () => {
  it("lists every tool for an unscoped caller", async () => {
    let result = await makeServer().dispatch(request("tools/list"), UNSCOPED) as any;
    expect(result.tools.map((tool: any) => tool.name))
        .toEqual(["echo", "explode", "crash", "privileged"]);
    expect(result.tools[0].inputSchema.required).toEqual(["text"]);
  });

  it("hides tools the caller's scopes don't cover", async () => {
    let result = await makeServer().dispatch(request("tools/list"), { scopes: [] }) as any;
    expect(result.tools.map((tool: any) => tool.name)).toEqual(["echo", "explode", "crash"]);
  });

  it("refuses a cursor it never issued", async () => {
    await expect(makeServer().dispatch(request("tools/list", { cursor: "x" }), UNSCOPED))
        .rejects.toMatchObject({ code: JSON_RPC_ERROR_CODES.invalidParams });
  });
});

describe("tools/call", () => {
  it("validates arguments, applies defaults, and returns content", async () => {
    let result = await makeServer().dispatch(
        request("tools/call", { name: "echo", arguments: { text: "hi" } }), UNSCOPED) as any;
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(result.isError).toBeUndefined();
  });

  it("reports a ToolError as a failed result, not a protocol error", async () => {
    // The distinction matters: MCP clients feed `isError` results back to their model, which is
    // where "the workspace is busy" belongs. A protocol error would surface as a broken connection.
    let result = await makeServer().dispatch(
        request("tools/call", { name: "explode", arguments: {} }), UNSCOPED) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("busy");
  });

  it("propagates an unexpected throw as a JSON-RPC internal error", async () => {
    await expect(makeServer().dispatch(
        request("tools/call", { name: "crash", arguments: {} }), UNSCOPED))
        .rejects.toMatchObject({ code: JSON_RPC_ERROR_CODES.internalError });
  });

  it("rejects an unknown tool", async () => {
    await expect(makeServer().dispatch(
        request("tools/call", { name: "nope", arguments: {} }), UNSCOPED))
        .rejects.toBeInstanceOf(JsonRpcError);
  });

  it("refuses a tool the caller's scopes don't cover", async () => {
    let result = await makeServer().dispatch(
        request("tools/call", { name: "privileged", arguments: {} }), { scopes: [] }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing admin");
  });

  it("allows a tool once the scope is granted", async () => {
    let result = await makeServer().dispatch(
        request("tools/call", { name: "privileged", arguments: {} }),
        { scopes: ["admin"] }) as any;
    expect(result.isError).toBeUndefined();
  });
});

describe("other methods", () => {
  it("answers ping", async () => {
    expect(await makeServer().dispatch(request("ping"), UNSCOPED)).toEqual({});
  });

  it("accepts notifications/initialized silently", async () => {
    let notification: JsonRpcRequest = { jsonrpc: "2.0", method: "notifications/initialized" };
    expect(await makeServer().dispatch(notification, UNSCOPED)).toBeUndefined();
  });

  it("rejects an unknown method", async () => {
    await expect(makeServer().dispatch(request("resources/list"), UNSCOPED))
        .rejects.toMatchObject({ code: JSON_RPC_ERROR_CODES.methodNotFound });
  });

  it("refuses duplicate tool names at construction", () => {
    expect(() => new McpServer<Ctx>({ name: "x", version: "1", tools: [echo, echo] }))
        .toThrowError(/Duplicate MCP tool name/);
  });
});

describe("validateToolArguments", () => {
  let schema = echo.inputSchema;

  it("requires the required", () => {
    expect(() => validateToolArguments("echo", schema, {}))
        .toThrowError(/requires "text"/);
  });

  it("fills declared defaults", () => {
    expect(validateToolArguments("echo", schema, { text: "a" })).toEqual({ text: "a", times: 1 });
  });

  it("treats null on an optional argument as absent", () => {
    // Several clients spell "not provided" as an explicit null; failing a type check there would
    // be technically defensible and practically useless.
    expect(validateToolArguments("echo", schema, { text: "a", mode: null }))
        .toEqual({ text: "a", times: 1 });
  });

  it("rejects a wrong type", () => {
    expect(() => validateToolArguments("echo", schema, { text: 5 }))
        .toThrowError(/must be of type string/);
  });

  it("rejects a non-integer where an integer is declared", () => {
    expect(() => validateToolArguments("echo", schema, { text: "a", times: 1.5 }))
        .toThrowError(/must be an integer/);
  });

  it("enforces string enums", () => {
    expect(() => validateToolArguments("echo", schema, { text: "a", mode: "sideways" }))
        .toThrowError(/must be one of: loud, quiet/);
  });

  it("rejects unknown properties when additionalProperties is false", () => {
    expect(() => validateToolArguments("echo", schema, { text: "a", extra: 1 }))
        .toThrowError(/no parameter named "extra"/);
  });

  it("accepts a missing arguments object", () => {
    expect(validateToolArguments("x", { type: "object", properties: {} }, undefined)).toEqual({});
  });
});
