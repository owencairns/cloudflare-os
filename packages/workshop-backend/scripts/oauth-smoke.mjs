// Live smoke test: walks the MCP authorization chain against a running local instance, over real
// HTTP, exactly as an external MCP client would -- 401, protected-resource metadata,
// authorization-server metadata, dynamic registration, authorize + PKCE, approval, token, and a
// scoped `tools/list` with the credential that came out.
//
//   node scripts/run-local.ts --port 8799                    # repo root, in another terminal
//   node packages/workshop-backend/scripts/oauth-smoke.mjs   # run from packages/workshop-backend
//
// `BASE` overrides the origin (default http://localhost:8799).
//
// The one step a script cannot do is click "Allow" in a browser, so the approval is made through
// the same `decideAgentAuthorization` RPC the approval page calls, on a session belonging to the
// account this script creates. Everything on either side of that is the real network path -- which
// is what distinguishes this from __integration__/oauth-flow.test.ts, where the whole stack runs
// in-process: this one also proves the *routing* (run_worker_first / the router's path list) is
// right, which is the part a workerd test cannot see.

import { newHttpBatchRpcSession } from "capnweb";

const BASE = process.env.BASE ?? "http://localhost:8799";
const PROTOCOL = "2025-06-18";
const REDIRECT_URI = "http://localhost:41999/oauth/callback";
let pass = 0, fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function deriveChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// --- 0. an account, so there is someone to approve the connection ---
const username = "oauthsmoke" + Math.random().toString(36).slice(2, 10);
let sessionToken;
{
  const api = newHttpBatchRpcSession(`${BASE}/api`);
  sessionToken = await api.createAccount(username, username, new Uint8Array([1, 2, 3]));
  if (!sessionToken) throw new Error("could not create account");
  console.log(`\naccount: ${username}`);
}

console.log("\n== step 1: the challenge ==");
{
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("unauthenticated /mcp is 401", res.status === 401, `status ${res.status}`);
  check("challenge names the protected-resource document",
        (res.headers.get("www-authenticate") ?? "").includes("oauth-protected-resource"));
}

console.log("\n== step 2-3: discovery ==");
let metadata;
{
  const prm = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
  check("protected-resource metadata is served", prm.status === 200, `status ${prm.status}`);
  const prmBody = await prm.json();
  check("resource is this origin", prmBody.resource === BASE, prmBody.resource);
  check("it names an authorization server",
        Array.isArray(prmBody.authorization_servers) && prmBody.authorization_servers.length === 1);

  // The variant a client with a pathful resource URL is told to try.
  const inserted = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
  check("the path-inserted well-known variant also answers", inserted.status === 200);

  const asm = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  check("authorization-server metadata is served", asm.status === 200, `status ${asm.status}`);
  metadata = await asm.json();
  check("S256 only", JSON.stringify(metadata.code_challenge_methods_supported) === '["S256"]');
  check("authorization_code only",
        JSON.stringify(metadata.grant_types_supported) === '["authorization_code"]');
  check("registration endpoint advertised", typeof metadata.registration_endpoint === "string");
}

console.log("\n== step 4: dynamic client registration ==");
let clientId;
{
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "OAuth Smoke Client", redirect_uris: [REDIRECT_URI] }),
  });
  check("registration returns 201", res.status === 201, `status ${res.status}`);
  const body = await res.json();
  clientId = body.client_id;
  check("a client_id was issued", typeof clientId === "string", JSON.stringify(body));
  check("no client_secret (public client)", body.client_secret === undefined);

  const bad = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Insecure", redirect_uris: ["http://evil.example/cb"] }),
  });
  check("a plaintext non-loopback redirect is refused", bad.status === 400, `status ${bad.status}`);
}

// --- 4b. the exact payload a real MCP client sends ---
//
// This is a regression replay, not a hypothetical. Claude Code's MCP client sent precisely this
// body to the deployed server and got back 400 invalid_client_metadata, because the validator
// demanded `grant_types` be exactly ["authorization_code"] and the client, wanting long-lived
// access, asks for refresh_token too. RFC 7591 §3.2.1: register the supported subset and *report
// back what was registered*. So the assertion is both halves -- it succeeds, and the response tells
// the client the truth about what it got.
console.log("\n== step 4b: the real Claude Code registration payload ==");
{
  const payload = {
    client_name: "Claude Code",
    redirect_uris: ["http://localhost:57321/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  console.log(`  --> POST ${metadata.registration_endpoint}`);
  console.log(`      ${JSON.stringify(payload)}`);
  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log(`  <-- ${res.status}`);
  console.log(JSON.stringify(body, null, 2).split("\n").map(l => `      ${l}`).join("\n"));

  check("Claude Code's registration is accepted (201)", res.status === 201, `status ${res.status}`);
  check("a client_id was issued", typeof body.client_id === "string");
  check("the registered grant_types are the supported subset",
        JSON.stringify(body.grant_types) === '["authorization_code"]',
        JSON.stringify(body.grant_types));
  check("response_types echo back as [\"code\"]",
        JSON.stringify(body.response_types) === '["code"]', JSON.stringify(body.response_types));
  check("registered as a public client",
        body.token_endpoint_auth_method === "none" && body.client_secret === undefined);
  check("the name the user will be shown survived", body.client_name === "Claude Code");
  check("the redirect it will listen on survived",
        JSON.stringify(body.redirect_uris) === JSON.stringify(payload.redirect_uris));

  // A desktop client that completes the flow through its own URL scheme rather than a loopback
  // listener -- refused before this change, allowed now (RFC 8252 §7.1).
  const custom = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Desktop Editor", redirect_uris: ["com.example.editor:/oauth/callback"],
    }),
  });
  check("a private-use scheme redirect registers", custom.status === 201, `status ${custom.status}`);

  // And the client that could never complete a flow here is still turned away.
  const hopeless = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Refresh Only", redirect_uris: [REDIRECT_URI], grant_types: ["refresh_token"],
    }),
  });
  check("a client with no authorization_code grant is refused",
        hopeless.status === 400, `status ${hopeless.status}`);

  // The refresh grant itself: a clean, spec-named error rather than a crash or a puzzle.
  const refresh = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "nope" }).toString(),
  });
  const refreshBody = await refresh.json();
  check("a refresh_token grant answers unsupported_grant_type at 400",
        refresh.status === 400 && refreshBody.error === "unsupported_grant_type",
        `${refresh.status} ${JSON.stringify(refreshBody)}`);
}

console.log("\n== step 5: authorize + approve ==");
const verifier = "smoke-verifier".padEnd(64, "v");
let code;
{
  const challenge = await deriveChallenge(verifier);
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "read build");
  url.searchParams.set("state", "smoke-state");

  const res = await fetch(url, { redirect: "manual" });
  check("authorize redirects", res.status === 302, `status ${res.status}`);
  const location = new URL(res.headers.get("location"), BASE);
  check("it redirects to the approval page", location.pathname === "/oauth/approve",
        location.pathname);
  const requestId = location.searchParams.get("request");
  check("carrying a request handle", !!requestId);

  // The approval page's own two calls, on the user's browser session.
  const api = newHttpBatchRpcSession(`${BASE}/api`);
  const auth = api.authenticate(sessionToken);
  const request = await auth.getAgentAuthorizationRequest(requestId);
  check("the request names the client", request?.clientName === "OAuth Smoke Client",
        JSON.stringify(request));
  check("and the scopes it asked for",
        JSON.stringify(request?.requestedScopes) === '["read","build"]',
        JSON.stringify(request?.requestedScopes));

  const api2 = newHttpBatchRpcSession(`${BASE}/api`);
  const redirect = new URL(await api2.authenticate(sessionToken)
      .decideAgentAuthorization(requestId, { approve: true, scopes: ["read"] }));
  check("approval redirects back to the client",
        redirect.origin + redirect.pathname === REDIRECT_URI, redirect.toString());
  check("state is echoed", redirect.searchParams.get("state") === "smoke-state");
  code = redirect.searchParams.get("code");
  check("with an authorization code", !!code);
}

console.log("\n== step 6: token ==");
let credential;
{
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId,
    code_verifier: verifier, redirect_uri: REDIRECT_URI,
  });
  const res = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  check("token exchange succeeds", res.status === 200, `status ${res.status}`);
  const body = await res.json();
  credential = body.access_token;
  check("Bearer token returned", body.token_type === "Bearer");
  check("it is an agent credential for this account",
        typeof credential === "string" && credential.startsWith(`mpk_${username}:`));
  check("granted scope is what the user approved (narrowed from the request)",
        body.scope === "read", body.scope);
  check("no refresh token in v1", body.refresh_token === undefined);

  // The code is single-use.
  const replay = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  check("replaying the code is refused", replay.status === 400, `status ${replay.status}`);
}

console.log("\n== step 7: the credential drives /mcp ==");
{
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL,
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("tools/list succeeds", res.status === 200, `status ${res.status}`);
  const names = (await res.json()).result.tools.map(t => t.name);
  check("read tools are offered", names.includes("list_workspaces") && names.includes("read_files"));
  check("build tools are not (only `read` was approved)",
        !names.includes("create_workspace") && !names.includes("write_file"),
        JSON.stringify(names));
}

console.log("\n== the user can see and revoke it ==");
{
  const api = newHttpBatchRpcSession(`${BASE}/api`);
  const connections = await api.authenticate(sessionToken).listAgentConnections();
  const found = connections.find(entry => entry.label === "OAuth Smoke Client");
  check("the connection is listed under its client_name", !!found,
        JSON.stringify(connections.map(entry => entry.label)));

  const api2 = newHttpBatchRpcSession(`${BASE}/api`);
  check("revoking reports success",
        await api2.authenticate(sessionToken).revokeAgentConnection(found.tokenId) === true);

  const after = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  check("the credential stops working immediately", after.status === 401, `status ${after.status}`);
}

console.log(`\n---\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
