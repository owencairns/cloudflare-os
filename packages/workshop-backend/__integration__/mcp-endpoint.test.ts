// End-to-end exercise of the /mcp endpoint against a real backend in workerd: real Durable
// Objects, real accounts, real git storage. This is the smoke test for the MCP server -- it drives
// the endpoint the way an external MCP client would (HTTP POST, JSON-RPC, bearer credential) rather
// than calling the tool handlers directly, so the transport, auth, dispatch, and the tools' use of
// the workshop API are all covered by the same run.

import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { beforeAll, describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSION } from "@gadgets/mcp-server/server";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const ORIGIN = "https://workshop.invalid";

let sessionToken: string;

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request(`${ORIGIN}/api`, {
    headers: { Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

/** Posts one JSON-RPC request to /mcp and returns the parsed envelope. */
async function rpc(method: string, params?: unknown,
                   options: { token?: string | null; id?: number } = {}): Promise<any> {
  const token = options.token === undefined ? sessionToken : options.token;
  const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: options.id ?? 1, method,
      ...(params === undefined ? {} : { params }),
    }),
  }));
  const text = await response.text();
  return { status: response.status, headers: response.headers,
           body: text ? JSON.parse(text) : undefined };
}

/** Calls a tool and returns its parsed JSON result, failing loudly on an `isError` result. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await rpc("tools/call", { name, arguments: args });
  expect(status).toBe(200);
  if (body.error) throw new Error(`${name} failed at the protocol level: ${body.error.message}`);
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(`${name} reported: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;  // Tools that return prose rather than JSON (e.g. delete_workspace).
  }
}

/** Calls a tool expecting it to refuse, returning the refusal text. */
async function callToolExpectingError(
    name: string, args: Record<string, unknown> = {}): Promise<string> {
  const { body } = await rpc("tools/call", { name, arguments: args });
  expect(body.result?.isError).toBe(true);
  return body.result.content[0].text;
}

describe("the /mcp endpoint", () => {
  beforeAll(async () => {
    using publicApi = await connect();
    const name = "mcp" + crypto.randomUUID().replaceAll("-", "");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error("Failed to create the test account.");
    sessionToken = token;
  });

  describe("transport and auth", () => {
    it("challenges an unauthenticated request with the OAuth discovery pointer", async () => {
      const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
      expect(response.status).toBe(401);
      const challenge = response.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain("Bearer");
      // This is the hook an MCP client follows to discover the authorization server.
      expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
      // A browser-hosted client can only read that header if it is exposed.
      expect(response.headers.get("Access-Control-Expose-Headers")).toContain("WWW-Authenticate");
    });

    it("rejects a bad credential without leaking why", async () => {
      const { status, body } = await rpc("tools/list", undefined,
                                         { token: "nosuchuser:nosuchtoken" });
      expect(status).toBe(401);
      expect(body.error).toBe("invalid_token");
    });

    it("405s GET, since stateless mode offers no server-initiated stream", async () => {
      const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      }));
      expect(response.status).toBe(405);
    });

    it("initializes", async () => {
      const { status, body } = await rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1" },
      });
      expect(status).toBe(200);
      expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(body.result.serverInfo.name).toBe("myoplan-os");
      expect(body.result.capabilities.tools).toBeDefined();
      expect(body.result.instructions).toContain("workspace");
    });

    it("accepts notifications/initialized with a 202", async () => {
      const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }));
      expect(response.status).toBe(202);
    });

    it("lists the v1 tool table", async () => {
      const { body } = await rpc("tools/list");
      const names = body.result.tools.map((tool: any) => tool.name);
      expect(names).toEqual([
        "list_workspaces", "create_workspace", "get_workspace", "delete_workspace",
        "create_gadget", "read_files", "write_file", "accept_changes", "list_chats",
        "send_message", "read_chat", "publish_blueprint", "install_blueprint",
        "list_blueprints", "outputs_list",
      ]);
      // No admin, approval, or collaborator tools in v1 -- deliberately absent rather than gated.
      for (const forbidden of ["admin", "approve", "collaborator", "share"]) {
        expect(names.some((name: string) => name.includes(forbidden))).toBe(false);
      }
      for (const tool of body.result.tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("rejects arguments that don't match a tool's schema", async () => {
      const { body } = await rpc("tools/call",
                                 { name: "get_workspace", arguments: { workspaceId: 7 } });
      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toContain("must be of type string");
    });
  });

  describe("the workspace round trip", () => {
    it("creates, edits, accepts, and reads back", async () => {
      // --- create_workspace ---
      const created = await callTool("create_workspace", { title: "MCP round trip" });
      const workspaceId = created.workspace.id as string;
      expect(typeof workspaceId).toBe("string");
      expect(created.workspace.title).toBe("MCP round trip");

      // --- create_gadget ---
      const gadget = await callTool("create_gadget", {
        workspaceId, title: "Widget", bindingName: "widget",
      });
      const gadgetId = gadget.gadget.id as number;
      expect(typeof gadgetId).toBe("number");

      // A chat is needed to hold proposed changes. `modelId: "none"` records the message without
      // starting an agent turn, which is what keeps this test deterministic (and free).
      const chat = await callTool("send_message", {
        workspaceId, text: "Setting up files via MCP.", modelId: "none",
      });
      const chatId = chat.chatId as number;
      expect(chat.started).toBe(false);

      // --- get_workspace: the gadget is there, permanent, with an empty initial commit ---
      const workspace = await callTool("get_workspace", { workspaceId });
      const listed = workspace.gadgets.find((entry: any) => entry.id === gadgetId);
      expect(listed).toBeDefined();
      expect(listed.title).toBe("Widget");
      // Created without a chatId, so it is permanent immediately and has a head to pin against.
      expect(listed.pendingInChat).toBeUndefined();
      expect(typeof listed.commitId).toBe("string");
      expect(workspace.chats.map((entry: any) => entry.id)).toContain(chatId);

      // --- write_file: proposed, not committed ---
      const written = await callTool("write_file", {
        workspaceId, gadgetId, chatId,
        path: "index.js", content: "export const answer = 42;\n",
      });
      expect(written.written).toBe("index.js");
      // First touch of a permanent gadget pins it at the head we just saw.
      expect(written.pinned).toBe(listed.commitId);
      expect(written.revision).toBeGreaterThan(0);

      // read_files reads *mainline*, so the proposed write must not be visible yet. This is the
      // assertion most worth having: it is the one place the tool table's semantics could quietly
      // drift into "writes are committed".
      const beforeAccept = await callTool("read_files", { workspaceId, gadgetId });
      expect(beforeAccept.files.map((file: any) => file.path)).not.toContain("index.js");

      // A second file in the same chat -- the gadget is already pinned, so no new pin is declared.
      const second = await callTool("write_file", {
        workspaceId, gadgetId, chatId, path: "README.md", content: "# Widget\n",
      });
      expect(second.pinned).toBeUndefined();

      // --- accept_changes ---
      const accepted = await callTool("accept_changes", { workspaceId, chatId });
      expect(accepted.outcome).toBe("merged");

      // --- read_files: now committed ---
      const afterAccept = await callTool("read_files", { workspaceId, gadgetId });
      const files = Object.fromEntries(
          afterAccept.files.map((file: any) => [file.path, file.content]));
      expect(files["index.js"]).toBe("export const answer = 42;\n");
      expect(files["README.md"]).toBe("# Widget\n");
      // The head advanced past the commit the write pinned against.
      expect(afterAccept.commitId).not.toBe(listed.commitId);

      // --- a whole-file overwrite of an existing file, in a fresh chat ---
      const secondChat = await callTool("send_message", {
        workspaceId, text: "Round two.", modelId: "none",
      });
      await callTool("write_file", {
        workspaceId, gadgetId, chatId: secondChat.chatId,
        path: "index.js", content: "export const answer = 43;\n",
      });
      expect((await callTool("accept_changes",
                             { workspaceId, chatId: secondChat.chatId })).outcome).toBe("merged");
      const rewritten = await callTool("read_files", { workspaceId, gadgetId });
      expect(rewritten.files.find((file: any) => file.path === "index.js").content)
          .toBe("export const answer = 43;\n");

      // --- list_chats / read_chat ---
      const chats = await callTool("list_chats", { workspaceId });
      expect(chats.chats.map((entry: any) => entry.id)).toContain(chatId);

      const transcript = await callTool("read_chat", { workspaceId, chatId });
      expect(transcript.messages.length).toBeGreaterThan(0);
      expect(transcript.messages[0].text).toContain("Setting up files via MCP.");
      // The accepted write shows up in the transcript as a changes/merge record.
      expect(transcript.messages.some(
          (message: any) => message.type === "changes" || message.type === "merge")).toBe(true);

      // --- list_workspaces sees it now that it is no longer provisional ---
      const listing = await callTool("list_workspaces");
      expect(listing.workspaces.map((entry: any) => entry.id)).toContain(workspaceId);

      // --- delete_workspace ---
      const deleted = await callTool("delete_workspace", { workspaceId });
      expect(String(deleted)).toContain(workspaceId);
    });
  });

  describe("error reporting", () => {
    it("reports a missing workspace as a tool error, not a protocol error", async () => {
      // The distinction matters: an MCP client feeds `isError` results to its model, which can act
      // on them, whereas a protocol error reads as a broken connection.
      const text = await callToolExpectingError("get_workspace", { workspaceId: "no-such-id" });
      expect(text).toContain("Could not open workspace");
    });

    it("names the gadgets that do exist when given a bad gadget id", async () => {
      const created = await callTool("create_workspace", { title: "Error cases" });
      const workspaceId = created.workspace.id as string;
      await callTool("create_gadget", { workspaceId, title: "Real gadget" });

      const text = await callToolExpectingError("read_files", { workspaceId, gadgetId: 99999 });
      expect(text).toContain("No gadget 99999");
      expect(text).toContain("Real gadget");

      await callTool("delete_workspace", { workspaceId });
    });

    it("names the chats that do exist when given a bad chat id", async () => {
      const created = await callTool("create_workspace", { title: "Bad chat" });
      const workspaceId = created.workspace.id as string;
      const gadget = await callTool("create_gadget", { workspaceId, title: "G" });

      const text = await callToolExpectingError("write_file", {
        workspaceId, gadgetId: gadget.gadget.id, chatId: 4242,
        path: "a.txt", content: "x",
      });
      expect(text).toContain("No chat 4242");

      await callTool("delete_workspace", { workspaceId });
    });
  });

  describe("read-only listings", () => {
    it("lists blueprints in the three buckets", async () => {
      const result = await callTool("list_blueprints");
      expect(Array.isArray(result.own)).toBe(true);
      expect(Array.isArray(result.library)).toBe(true);
      expect(Array.isArray(result.featured)).toBe(true);
    });

    it("lists outputs", async () => {
      const result = await callTool("outputs_list");
      expect(Array.isArray(result.outputs)).toBe(true);
    });
  });
});
