import { describe, expect, it } from "vitest";
import { JSON_RPC_ERROR_CODES } from "../src/jsonrpc.js";
import { MCP_PROTOCOL_VERSION, McpServer } from "../src/server.js";
import { defineTool } from "../src/tool.js";
import { MAX_REQUEST_BODY_BYTES, handleStreamableHttp } from "../src/transport.js";

type Ctx = { calls: string[] };

const server = new McpServer<Ctx>({
  name: "t", version: "1",
  tools: [defineTool<Ctx>({
    name: "note",
    description: "Records that it ran.",
    inputSchema: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
    handler: (args, ctx) => { ctx.calls.push(args.what as string); return `noted ${args.what}`; },
  })],
});

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://instance.invalid/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(req: Request): Promise<{ response: Response; body: any; ctx: Ctx }> {
  let ctx: Ctx = { calls: [] };
  let response = await handleStreamableHttp(req, server, ctx);
  let text = await response.text();
  // Transport-level refusals (415, 406, 413, unsupported protocol version) answer in plain text on
  // purpose: they never entered JSON-RPC, so there is no id to address a JSON-RPC error to.
  let isJson = response.headers.get("Content-Type")?.startsWith("application/json") ?? false;
  return { response, body: isJson && text ? JSON.parse(text) : undefined, ctx };
}

describe("method handling", () => {
  it("answers a preflight with CORS headers and no body", async () => {
    let response = await handleStreamableHttp(
        new Request("https://instance.invalid/mcp", { method: "OPTIONS" }),
        server, { calls: [] });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Without this a browser client cannot read the challenge that starts OAuth discovery.
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
  });

  it("405s GET, because stateless mode has no server-initiated stream", async () => {
    let response = await handleStreamableHttp(
        new Request("https://instance.invalid/mcp"), server, { calls: [] });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, OPTIONS");
  });

  it("405s DELETE, because there is no session to end", async () => {
    let response = await handleStreamableHttp(
        new Request("https://instance.invalid/mcp", { method: "DELETE" }), server, { calls: [] });
    expect(response.status).toBe(405);
  });
});

describe("request validation", () => {
  it("requires a JSON content type", async () => {
    let { response } = await call(new Request("https://instance.invalid/mcp", {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
    }));
    expect(response.status).toBe(415);
  });

  it("406s a client that explicitly won't take JSON", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" },
                                       { Accept: "text/html" }));
    expect(response.status).toBe(406);
  });

  it("accepts a missing Accept header", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(response.status).toBe(200);
  });

  it("accepts the Accept header MCP clients actually send", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" },
                                       { Accept: "application/json, text/event-stream" }));
    expect(response.status).toBe(200);
  });

  it("rejects a protocol version it doesn't speak", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" },
                                       { "MCP-Protocol-Version": "1999-01-01" }));
    expect(response.status).toBe(400);
  });

  it("accepts the protocol version it does speak", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" },
                                       { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION }));
    expect(response.status).toBe(200);
  });

  it("ignores an Mcp-Session-Id rather than rejecting it", async () => {
    // Stateless mode issues none, but a client carrying one from elsewhere is better served by
    // working than by a protocol error.
    let { response } = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" },
                                       { "Mcp-Session-Id": "leftover" }));
    expect(response.status).toBe(200);
  });

  it("refuses an oversized body on Content-Length alone", async () => {
    let request = post({ jsonrpc: "2.0", id: 1, method: "ping" });
    request.headers.set("Content-Length", String(MAX_REQUEST_BODY_BYTES + 1));
    let { response } = await call(request);
    expect(response.status).toBe(413);
  });

  it("reports unparseable JSON as a JSON-RPC error with a null id", async () => {
    let { response, body } = await call(post("{not json"));
    expect(response.status).toBe(400);
    expect(body).toMatchObject({ id: null, error: { code: JSON_RPC_ERROR_CODES.parseError } });
  });
});

describe("dispatch", () => {
  it("returns a single response for a single request", async () => {
    let { response, body, ctx } = await call(post({
      jsonrpc: "2.0", id: 42, method: "tools/call",
      params: { name: "note", arguments: { what: "hello" } },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("MCP-Protocol-Version")).toBe(MCP_PROTOCOL_VERSION);
    expect(body.id).toBe(42);
    expect(body.result.content[0].text).toBe("noted hello");
    // The context the host built is what the handler received -- the transport never touches it.
    expect(ctx.calls).toEqual(["hello"]);
  });

  it("202s a payload that is only notifications", async () => {
    let { response } = await call(post({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("answers a batch with an array, one entry per non-notification", async () => {
    let { body } = await call(post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]));
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.map((entry: any) => entry.id)).toEqual([1, 2]);
  });

  it("addresses a per-request error to that request's id and answers the rest", async () => {
    let { body } = await call(post([
      { jsonrpc: "2.0", id: 1, method: "does/not/exist" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]));
    expect(body[0].error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
    expect(body[1].result).toEqual({});
  });

  it("still returns 200 when the JSON-RPC call itself failed", async () => {
    // A JSON-RPC-level error is a successful HTTP exchange; conflating the two breaks clients that
    // key retries off the status code.
    let { response, body } = await call(post({ jsonrpc: "2.0", id: 1, method: "nope" }));
    expect(response.status).toBe(200);
    expect(body.error.code).toBe(JSON_RPC_ERROR_CODES.methodNotFound);
  });

  it("drops a malformed notification instead of inventing an id to answer", async () => {
    let { response } = await call(post({ jsonrpc: "1.0", method: "ping" }));
    expect(response.status).toBe(202);
  });
});

describe("end-to-end handshake", () => {
  it("initializes, lists, and calls", async () => {
    let init = await call(post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    }));
    expect(init.body.result.serverInfo.name).toBe("t");

    let listed = await call(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toEqual(["note"]);

    let called = await call(post({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "note", arguments: { what: "done" } },
    }));
    expect(called.body.result.content[0].text).toBe("noted done");
  });
});
