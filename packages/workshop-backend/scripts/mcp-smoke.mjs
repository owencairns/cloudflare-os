// Live smoke test: drives the /mcp endpoint of a running local instance exactly as an external
// MCP client would. Creates its own account over the Cap'n Web endpoint, then does everything else
// through /mcp.
//
//   node scripts/run-local.ts --port 8799                  # repo root, in another terminal
//   node packages/workshop-backend/scripts/mcp-smoke.mjs   # run from packages/workshop-backend
//
// `BASE` overrides the origin (default http://localhost:8799).
//
// Why this exists alongside `__integration__/mcp-endpoint.test.ts`: that test is the canonical
// one, but the whole workerd test pool in this repo currently fails to collect
// (@cloudflare/vitest-pool-workers 0.20.3 against vitest 4.1.10 -- every existing suite under
// __tests__/ and __integration__/ fails the same way, on the base branch as much as here). Until
// that is fixed, this script is how the endpoint gets exercised against a real instance: real
// Durable Objects, real git storage, real auth. It earned its keep immediately by catching a bug
// the type system could not -- the workpiece subscriber has to be a Cap'n Web `RpcStub`, not a
// bare RpcTarget.
import { newHttpBatchRpcSession } from "capnweb";

const BASE = process.env.BASE ?? "http://localhost:8799";
const PROTOCOL = "2025-06-18";
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

let token = null;
let nextId = 1;

async function rpc(method, params, { auth = true, raw = false } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const body = isJson && text ? JSON.parse(text) : text;
  return raw ? { res, body } : body;
}

async function tool(name, args = {}) {
  const body = await rpc("tools/call", { name, arguments: args });
  if (body.error) throw new Error(`${name}: protocol error ${body.error.message}`);
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function toolError(name, args = {}) {
  const body = await rpc("tools/call", { name, arguments: args });
  if (!body.result?.isError) throw new Error(`${name} unexpectedly succeeded`);
  return body.result.content[0].text;
}

// --- 0. account ---
const username = "mcpsmoke" + Math.random().toString(36).slice(2, 10);
{
  const api = newHttpBatchRpcSession(`${BASE}/api`);
  token = await api.createAccount(username, username, new Uint8Array([1, 2, 3]));
  if (!token) throw new Error("could not create account");
  console.log(`\naccount: ${username}`);
}

console.log("\n== transport + auth ==");
{
  const { res } = await rpc("tools/list", undefined, { auth: false, raw: true });
  check("unauthenticated request is refused", res.status === 401, `status ${res.status}`);
  const challenge = res.headers.get("www-authenticate") ?? "";
  check("challenge points at protected-resource metadata",
        challenge.includes("oauth-protected-resource"), challenge);
  check("WWW-Authenticate is exposed to browser clients",
        (res.headers.get("access-control-expose-headers") ?? "").includes("WWW-Authenticate"));

  const bad = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer nouser:notoken" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  check("bad credential is refused", bad.status === 401, `status ${bad.status}`);

  const get = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  check("GET is 405 (stateless: no SSE stream)", get.status === 405, `status ${get.status}`);

  const opts = await fetch(`${BASE}/mcp`, { method: "OPTIONS" });
  check("OPTIONS preflight is 204", opts.status === 204, `status ${opts.status}`);
}

console.log("\n== initialize ==");
{
  const body = await rpc("initialize", {
    protocolVersion: PROTOCOL, capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  check("protocolVersion echoed", body.result?.protocolVersion === PROTOCOL);
  check("serverInfo names the instance", body.result?.serverInfo?.name === "myoplan-os",
        JSON.stringify(body.result?.serverInfo));
  check("tools capability advertised", !!body.result?.capabilities?.tools);
  check("instructions describe the model", (body.result?.instructions ?? "").includes("workspace"));

  const notif = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("notifications/initialized -> 202", notif.status === 202, `status ${notif.status}`);
}

console.log("\n== tools/list ==");
const EXPECTED = ["list_workspaces", "create_workspace", "get_workspace", "delete_workspace",
  "create_gadget", "read_files", "write_file", "accept_changes", "list_chats", "send_message",
  "read_chat", "publish_blueprint", "install_blueprint", "list_blueprints", "outputs_list"];
{
  const body = await rpc("tools/list");
  const names = body.result.tools.map(t => t.name);
  check(`all ${EXPECTED.length} v1 tools listed`,
        JSON.stringify(names) === JSON.stringify(EXPECTED), JSON.stringify(names));
  check("every tool has a description and object schema",
        body.result.tools.every(t => t.description && t.inputSchema?.type === "object"));
  check("no admin/approval/collaborator tools",
        !names.some(n => /admin|approve|collaborator|share/.test(n)));

  const badArgs = await rpc("tools/call", { name: "get_workspace", arguments: { workspaceId: 7 } });
  check("schema violation -> invalidParams", badArgs.error?.code === -32602, JSON.stringify(badArgs.error));

  const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
  check("unknown tool -> JSON-RPC error", !!unknown.error);
}

console.log("\n== workspace round trip ==");
let workspaceId;
{
  const created = await tool("create_workspace", { title: "MCP smoke" });
  workspaceId = created.workspace.id;
  check("create_workspace returns an id", typeof workspaceId === "string", workspaceId);
  check("title applied", created.workspace.title === "MCP smoke");

  const g = await tool("create_gadget", { workspaceId, title: "Widget", bindingName: "widget" });
  const gadgetId = g.gadget.id;
  check("create_gadget returns a numeric id", typeof gadgetId === "number", String(gadgetId));

  const chat = await tool("send_message",
                          { workspaceId, text: "Setting up via MCP.", modelId: "none" });
  const chatId = chat.chatId;
  check("send_message with modelId=none starts no agent", chat.started === false);
  check("chat id returned", typeof chatId === "number");

  const ws = await tool("get_workspace", { workspaceId });
  const listed = ws.gadgets.find(x => x.id === gadgetId);
  check("get_workspace lists the gadget", !!listed);
  check("gadget is permanent (not pending in a chat)", listed?.pendingInChat === undefined);
  check("gadget has a head commit to pin against", typeof listed?.commitId === "string");
  check("get_workspace lists the chat", ws.chats.some(c => c.id === chatId));

  const w1 = await tool("write_file", {
    workspaceId, gadgetId, chatId, path: "index.js", content: "export const answer = 42;\n",
  });
  check("write_file accepted", w1.written === "index.js");
  check("first touch pins the gadget at head", w1.pinned === listed.commitId,
        `${w1.pinned} vs ${listed.commitId}`);
  check("revision advanced", w1.revision > 0, String(w1.revision));

  const before = await tool("read_files", { workspaceId, gadgetId });
  check("write is PROPOSED, not committed (invisible to read_files)",
        !before.files.some(f => f.path === "index.js"),
        JSON.stringify(before.files.map(f => f.path)));

  const w2 = await tool("write_file", {
    workspaceId, gadgetId, chatId, path: "README.md", content: "# Widget\n",
  });
  check("second write in same chat re-uses the pin", w2.pinned === undefined);

  const acc = await tool("accept_changes", { workspaceId, chatId });
  check("accept_changes merged", acc.outcome === "merged", JSON.stringify(acc));

  const after = await tool("read_files", { workspaceId, gadgetId });
  const files = Object.fromEntries(after.files.map(f => [f.path, f.content]));
  check("index.js round-tripped", files["index.js"] === "export const answer = 42;\n",
        JSON.stringify(files["index.js"]));
  check("README.md round-tripped", files["README.md"] === "# Widget\n");
  check("head advanced past the pinned commit", after.commitId !== listed.commitId);

  // Overwrite an existing file in a fresh chat (second epoch, re-pins).
  const chat2 = await tool("send_message", { workspaceId, text: "Round two.", modelId: "none" });
  await tool("write_file", {
    workspaceId, gadgetId, chatId: chat2.chatId,
    path: "index.js", content: "export const answer = 43;\n",
  });
  const acc2 = await tool("accept_changes", { workspaceId, chatId: chat2.chatId });
  check("second accept merged", acc2.outcome === "merged", JSON.stringify(acc2));
  const after2 = await tool("read_files", { workspaceId, gadgetId });
  check("overwrite round-tripped",
        after2.files.find(f => f.path === "index.js").content === "export const answer = 43;\n");

  const chats = await tool("list_chats", { workspaceId });
  check("list_chats sees both chats", chats.chats.length >= 2, String(chats.chats.length));

  const tx = await tool("read_chat", { workspaceId, chatId });
  check("read_chat returns the message text",
        tx.messages.some(m => (m.text ?? "").includes("Setting up via MCP.")));
  check("read_chat records the accepted changes",
        tx.messages.some(m => m.type === "changes" || m.type === "merge"),
        JSON.stringify(tx.messages.map(m => m.type)));

  const listing = await tool("list_workspaces");
  check("list_workspaces includes the (now non-provisional) workspace",
        listing.workspaces.some(w => w.id === workspaceId));
}

console.log("\n== error reporting ==");
{
  const t1 = await toolError("get_workspace", { workspaceId: "no-such-id" });
  check("missing workspace -> isError result, not protocol error",
        t1.includes("Could not open workspace"), t1);

  const t2 = await toolError("read_files", { workspaceId, gadgetId: 99999 });
  check("bad gadget id names what does exist", t2.includes("No gadget 99999"), t2);

  const t3 = await toolError("write_file", {
    workspaceId, gadgetId: 1, chatId: 4242, path: "a.txt", content: "x",
  });
  check("bad chat id names what does exist", t3.includes("No chat 4242"), t3);
}

console.log("\n== read-only listings ==");
{
  const bp = await tool("list_blueprints");
  check("list_blueprints returns three buckets",
        Array.isArray(bp.own) && Array.isArray(bp.library) && Array.isArray(bp.featured));
  const out = await tool("outputs_list");
  check("outputs_list returns an array", Array.isArray(out.outputs));
}

console.log("\n== cleanup ==");
{
  const del = await tool("delete_workspace", { workspaceId });
  check("delete_workspace succeeded", String(del).includes(workspaceId), String(del));
}

console.log(`\n---\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
