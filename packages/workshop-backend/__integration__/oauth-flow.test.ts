// The whole agent-connect flow, driven headlessly against a real backend in workerd.
//
// This is the test that matters for the branch's claim: *any* MCP client pointed at this origin can
// get from an unauthenticated `/mcp` POST to a working, scope-limited tool call with no human
// pasting a token anywhere. So it walks the spec's chain exactly as a client would -- 401,
// protected-resource metadata, authorization-server metadata, dynamic registration, authorize +
// PKCE, token -- and only the approval step is short-circuited, by calling the same
// `decideAgentAuthorization` RPC the approval page calls.

import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { AGENT_CREDENTIAL_PREFIX } from "@gadgets/workshop-shared/api";
import { beforeAll, describe, expect, it } from "vitest";
import { MCP_PROTOCOL_VERSION } from "@gadgets/mcp-server/server";
import { deriveCodeChallenge } from "../src/auth/oauth/protocol.js";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const ORIGIN = "https://workshop.invalid";
const REDIRECT_URI = "http://localhost:41999/oauth/callback";

let sessionToken: string;
let username: string;

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

/** Opens an authenticated session as the test user -- i.e. what their browser holds. */
async function asUser<T>(body: (api: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  using publicApi = await connect();
  using api = await publicApi.authenticate(sessionToken);
  return await body(api);
}

async function getJson(path: string): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await exports.default.fetch(new Request(`${ORIGIN}${path}`));
  const text = await response.text();
  return { status: response.status, headers: response.headers,
           body: text ? JSON.parse(text) : undefined };
}

/** Registers a client the way an MCP client does on first contact. */
async function register(
    body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await exports.default.fetch(new Request(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

/** GETs /oauth/authorize without following the redirect, returning the `Location`. */
async function authorize(params: Record<string, string>): Promise<Response> {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return exports.default.fetch(new Request(url.toString(), { redirect: "manual" }));
}

async function token(form: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await exports.default.fetch(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function mcp(method: string, params: unknown, credential: string): Promise<any> {
  const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      Authorization: `Bearer ${credential}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method,
                           ...(params === undefined ? {} : { params }) }),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

/** A PKCE pair, as a client generates one per authorization. */
async function pkce(seed: string): Promise<{ verifier: string; challenge: string }> {
  const verifier = seed.padEnd(64, "z");
  return { verifier, challenge: await deriveCodeChallenge(verifier) };
}

/**
 * Runs registration -> authorize -> approve, returning what the token request will need. The
 * approval is made through the same RPC the approval page calls, so the code path under test is the
 * production one; only the clicking is simulated.
 */
async function authorizeAndApprove(options: {
  clientName?: string;
  scope?: string;
  approvedScopes?: string[];
  state?: string;
  seed?: string;
} = {}) {
  const registration = await register({
    client_name: options.clientName ?? "Headless Test Client",
    redirect_uris: [REDIRECT_URI],
  });
  expect(registration.status).toBe(201);
  const clientId = registration.body.client_id as string;

  const { verifier, challenge } = await pkce(options.seed ?? "verifier-one");
  const state = options.state ?? "opaque-client-state";
  const response = await authorize({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
  });
  expect(response.status).toBe(302);

  const approvalUrl = new URL(response.headers.get("Location")!);
  expect(approvalUrl.pathname).toBe("/oauth/approve");
  const requestId = approvalUrl.searchParams.get("request")!;

  const redirect = await asUser(async (api) => {
    const request = await api.getAgentAuthorizationRequest(requestId);
    expect(request).not.toBeNull();
    return api.decideAgentAuthorization(requestId, {
      approve: true,
      scopes: (options.approvedScopes ?? request!.grantableScopes) as any,
    });
  });

  const target = new URL(redirect);
  expect(target.origin + target.pathname).toBe(REDIRECT_URI);
  expect(target.searchParams.get("state")).toBe(state);
  const code = target.searchParams.get("code")!;
  expect(code).toBeTruthy();

  return { clientId, code, verifier, challenge, requestId };
}

describe("the OAuth agent-connect flow", () => {
  beforeAll(async () => {
    using publicApi = await connect();
    const name = "oauth" + crypto.randomUUID().replaceAll("-", "");
    const created = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (created === null) throw new Error("Failed to create the test account.");
    sessionToken = created;
    username = name;
  });

  describe("discovery", () => {
    it("points an unauthenticated /mcp request at the protected-resource metadata", async () => {
      const response = await exports.default.fetch(new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate"))
          .toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    });

    it("serves the document that header names", async () => {
      const { status, body, headers } = await getJson("/.well-known/oauth-protected-resource");
      expect(status).toBe(200);
      expect(body.resource).toBe(ORIGIN);
      expect(body.authorization_servers).toEqual([ORIGIN]);
      // Browser-hosted clients read this cross-origin.
      expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("answers the spec's path-inserted well-known variants identically", async () => {
      // A client whose resource URL has a path is told to insert it: .../oauth-protected-resource/mcp
      const inserted = await getJson("/.well-known/oauth-protected-resource/mcp");
      const bare = await getJson("/.well-known/oauth-protected-resource");
      expect(inserted.status).toBe(200);
      expect(inserted.body).toEqual(bare.body);
    });

    it("serves authorization-server metadata naming reachable endpoints", async () => {
      const { status, body } = await getJson("/.well-known/oauth-authorization-server");
      expect(status).toBe(200);
      expect(body.issuer).toBe(ORIGIN);
      expect(body.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
      expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(body.grant_types_supported).toEqual(["authorization_code"]);
    });

    it("answers a CORS preflight on the token endpoint", async () => {
      const response = await exports.default.fetch(
          new Request(`${ORIGIN}/oauth/token`, { method: "OPTIONS" }));
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });
  });

  describe("dynamic client registration", () => {
    it("issues a client_id with no secret", async () => {
      const { status, body } = await register({
        client_name: "Registration Test", redirect_uris: [REDIRECT_URI],
      });
      expect(status).toBe(201);
      expect(typeof body.client_id).toBe("string");
      expect(body.client_secret).toBeUndefined();
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.client_name).toBe("Registration Test");
    });

    it("refuses a plaintext non-loopback redirect URI", async () => {
      const { status, body } = await register({
        client_name: "Insecure", redirect_uris: ["http://evil.example/cb"],
      });
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_redirect_uri");
    });

    it("refuses a registration with no client_name", async () => {
      const { status, body } = await register({ redirect_uris: [REDIRECT_URI] });
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_client_metadata");
    });
  });

  describe("the authorization endpoint", () => {
    it("refuses an unknown client without redirecting anywhere", async () => {
      // Critical: an unverified client_id must never produce a redirect, or this endpoint becomes
      // an open redirector.
      const response = await authorize({
        response_type: "code", client_id: "mpc_nope", redirect_uri: REDIRECT_URI,
        code_challenge: (await pkce("x")).challenge, code_challenge_method: "S256",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect((await response.json() as any).error).toBe("invalid_client");
    });

    it("refuses a redirect_uri that was not registered", async () => {
      const { body } = await register({
        client_name: "Mismatch", redirect_uris: [REDIRECT_URI],
      });
      const response = await authorize({
        response_type: "code", client_id: body.client_id,
        redirect_uri: "http://localhost:41999/somewhere-else",
        code_challenge: (await pkce("x")).challenge, code_challenge_method: "S256",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
    });

    it("redirects protocol errors back to a verified client, with state", async () => {
      const { body } = await register({
        client_name: "Bad Params", redirect_uris: [REDIRECT_URI],
      });
      // No code_challenge: PKCE is mandatory here.
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        state: "carried-through",
      });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("state")).toBe("carried-through");
    });

    it("refuses the plain PKCE downgrade", async () => {
      const { body } = await register({ client_name: "Plain", redirect_uris: [REDIRECT_URI] });
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        code_challenge: (await pkce("x")).verifier, code_challenge_method: "plain",
      });
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("error_description")).toContain("S256");
    });

    it("sends an approved request to the frontend approval page", async () => {
      const { requestId } = await authorizeAndApprove({ seed: "verifier-page" });
      expect(requestId.startsWith("mpr_")).toBe(true);
    });
  });

  describe("the approval step", () => {
    it("shows the client name and the scopes it asked for", async () => {
      const { body } = await register({
        client_name: "Inspector", redirect_uris: [REDIRECT_URI],
      });
      const { challenge } = await pkce("verifier-inspect");
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        code_challenge: challenge, code_challenge_method: "S256", scope: "read chat",
      });
      const requestId = new URL(response.headers.get("Location")!).searchParams.get("request")!;

      const request = await asUser(api => api.getAgentAuthorizationRequest(requestId));
      expect(request!.clientName).toBe("Inspector");
      expect(request!.redirectUri).toBe(REDIRECT_URI);
      expect(request!.requestedScopes).toEqual(["read", "chat"]);
      // The test account is not an admin, so `admin` is never grantable; it wasn't asked for here.
      expect(request!.grantableScopes).toEqual(["read", "chat"]);
    });

    it("filters `admin` out of what a non-admin may grant", async () => {
      const { body } = await register({ client_name: "Ambitious", redirect_uris: [REDIRECT_URI] });
      const { challenge } = await pkce("verifier-admin");
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        code_challenge: challenge, code_challenge_method: "S256", scope: "read admin",
      });
      const requestId = new URL(response.headers.get("Location")!).searchParams.get("request")!;

      const request = await asUser(api => api.getAgentAuthorizationRequest(requestId));
      expect(request!.requestedScopes).toEqual(["read", "admin"]);
      expect(request!.grantableScopes).toEqual(["read"]);

      // And approving `admin` anyway is refused, rather than quietly ignored.
      await expect(asUser(api => api.decideAgentAuthorization(
          requestId, { approve: true, scopes: ["read", "admin"] })))
          .rejects.toThrow(/subset/);
    });

    it("consumes the request, so a decision cannot be replayed", async () => {
      const { requestId } = await authorizeAndApprove({ seed: "verifier-replay" });
      expect(await asUser(api => api.getAgentAuthorizationRequest(requestId))).toBeNull();
      await expect(asUser(api => api.decideAgentAuthorization(requestId, { approve: false })))
          .rejects.toThrow(/expired or was already answered/);
    });

    it("returns an access_denied redirect when the user declines", async () => {
      const { body } = await register({ client_name: "Declined", redirect_uris: [REDIRECT_URI] });
      const { challenge } = await pkce("verifier-deny");
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        code_challenge: challenge, code_challenge_method: "S256", state: "deny-state",
      });
      const requestId = new URL(response.headers.get("Location")!).searchParams.get("request")!;

      const redirect = new URL(
          await asUser(api => api.decideAgentAuthorization(requestId, { approve: false })));
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("deny-state");
      expect(redirect.searchParams.get("code")).toBeNull();
    });

    it("refuses to approve nothing", async () => {
      const { body } = await register({ client_name: "Empty", redirect_uris: [REDIRECT_URI] });
      const { challenge } = await pkce("verifier-empty");
      const response = await authorize({
        response_type: "code", client_id: body.client_id, redirect_uri: REDIRECT_URI,
        code_challenge: challenge, code_challenge_method: "S256",
      });
      const requestId = new URL(response.headers.get("Location")!).searchParams.get("request")!;
      await expect(asUser(api => api.decideAgentAuthorization(
          requestId, { approve: true, scopes: [] })))
          .rejects.toThrow(/at least one scope/);
    });
  });

  describe("the token endpoint", () => {
    it("exchanges a code for an agent credential", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({
        clientName: "Token Client", scope: "read build", seed: "verifier-token",
      });
      const { status, body } = await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      });
      expect(status).toBe(200);
      expect(body.token_type).toBe("Bearer");
      expect(body.scope).toBe("read build");
      // The credential is an ordinary agent credential for this account -- the whole point.
      expect(body.access_token.startsWith(`${AGENT_CREDENTIAL_PREFIX}${username}:`)).toBe(true);
      // v1 issues no refresh token and no expiry; see protocol.ts.
      expect(body.refresh_token).toBeUndefined();
      expect(body.expires_in).toBeUndefined();
    });

    it("burns the code: a second exchange fails", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({ seed: "verifier-single" });
      const form = {
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      };
      expect((await token(form)).status).toBe(200);
      const second = await token(form);
      expect(second.status).toBe(400);
      expect(second.body.error).toBe("invalid_grant");
    });

    it("rejects a wrong code_verifier, and spends the code doing so", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({ seed: "verifier-pkce" });
      const wrong = await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: "attacker".padEnd(64, "q"), redirect_uri: REDIRECT_URI,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe("invalid_grant");

      // Even the rightful holder cannot retry it: a failed exchange means the code has leaked.
      const retry = await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      });
      expect(retry.body.error).toBe("invalid_grant");
    });

    it("rejects a code presented by a different client", async () => {
      const { code, verifier } = await authorizeAndApprove({ seed: "verifier-crossclient" });
      const other = await register({ client_name: "Other", redirect_uris: [REDIRECT_URI] });
      const { status, body } = await token({
        grant_type: "authorization_code", code, client_id: other.body.client_id,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      });
      expect(status).toBe(400);
      expect(body.error).toBe("invalid_grant");
    });

    it("rejects a mismatched redirect_uri", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({ seed: "verifier-redirect" });
      const { body } = await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: "http://localhost:41999/elsewhere",
      });
      expect(body.error).toBe("invalid_grant");
    });

    it("rejects grants it does not implement", async () => {
      const { body, status } = await token({ grant_type: "refresh_token", refresh_token: "x" });
      expect(status).toBe(400);
      expect(body.error).toBe("unsupported_grant_type");
    });

    it("rejects a client that sends a secret", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({ seed: "verifier-secret" });
      const { status, body } = await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, client_secret: "hunter2",
      });
      expect(status).toBe(401);
      expect(body.error).toBe("invalid_client");
    });

    it("issues a code whose lifetime is the documented five minutes", async () => {
      // Clock-based expiry cannot be exercised without advancing time here, so this pins the
      // window the record is written with -- the value the expiry check reads.
      const { clientId, code, verifier } = await authorizeAndApprove({ seed: "verifier-ttl" });
      const record = await exports.OAuthProvider.getByName("")
          .consumeCode(code, clientId, REDIRECT_URI);
      expect(record.ok).toBe(true);
      if (!record.ok) throw new Error("unreachable");
      const remaining = record.record.expiresAt.valueOf() - Date.now();
      expect(remaining).toBeGreaterThan(4 * 60_000);
      expect(remaining).toBeLessThanOrEqual(5 * 60_000);
      // (verifier is unused here; the DO-level call bypasses PKCE, which the endpoint owns.)
      expect(verifier).toBeTruthy();
    });
  });

  describe("the credential the flow produced", () => {
    it("drives /mcp with exactly the approved scopes", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({
        clientName: "Read Only Agent", scope: "read", seed: "verifier-mcp-read",
      });
      const credential = (await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      })).body.access_token as string;

      const { status, body } = await mcp("tools/list", undefined, credential);
      expect(status).toBe(200);
      const names = (body.result.tools as any[]).map(tool => tool.name);
      expect(names).toContain("list_workspaces");
      expect(names).toContain("read_files");
      // The scopes the user approved are the scopes the tool seam enforces -- no translation layer.
      expect(names).not.toContain("create_workspace");
      expect(names).not.toContain("send_message");
    });

    it("carries a wider grant when the user approved one", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({
        clientName: "Builder Agent", scope: "read build", seed: "verifier-mcp-build",
      });
      const credential = (await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      })).body.access_token as string;

      const { body } = await mcp(
          "tools/call", { name: "create_workspace", arguments: { title: "Made via OAuth" } },
          credential);
      expect(body.result.isError).toBeFalsy();
      const workspaceId = JSON.parse(body.result.content[0].text).workspace.id as string;

      await mcp("tools/call", { name: "delete_workspace", arguments: { workspaceId } }, credential);
    });

    it("appears in the user's connected-agent list, and revoking it kills the credential",
       async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({
        clientName: "Revocation Target", scope: "read", seed: "verifier-revoke",
      });
      const credential = (await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      })).body.access_token as string;
      expect((await mcp("tools/list", undefined, credential)).status).toBe(200);

      const tokenId = await asUser(async (api) => {
        const connections = await api.listAgentConnections();
        const found = connections.find(entry => entry.label === "Revocation Target");
        expect(found).toBeDefined();
        // The label is the client_name the user approved, and the scopes are what they approved.
        expect(found!.scopes).toEqual(["read"]);
        return found!.tokenId;
      });

      expect(await asUser(api => api.revokeAgentConnection(tokenId))).toBe(true);
      // Revocation is immediate: the credential no longer authenticates at /mcp.
      expect((await mcp("tools/list", undefined, credential)).status).toBe(401);
      // And a second revoke reports that there was nothing left to remove.
      expect(await asUser(api => api.revokeAgentConnection(tokenId))).toBe(false);
    });

    it("refuses to let an agent credential manage or mint connections", async () => {
      const { clientId, code, verifier } = await authorizeAndApprove({
        clientName: "Would-be Minter", seed: "verifier-selfmint",
      });
      const credential = (await token({
        grant_type: "authorization_code", code, client_id: clientId,
        code_verifier: verifier, redirect_uri: REDIRECT_URI,
      })).body.access_token as string;

      using publicApi = await connect();
      using api = await publicApi.authenticate(credential);
      // Even a fully-scoped agent credential is not the user's presence: approving, listing and
      // revoking connections are browser-session-only.
      await expect(api.listAgentConnections()).rejects.toThrow(/browser session/);
      await expect(api.revokeAgentConnection("whatever")).rejects.toThrow(/browser session/);
      await expect(api.getAgentAuthorizationRequest("mpr_x")).rejects.toThrow(/browser session/);
    });
  });
});
