// The authorization server's wire contract and its validation rules, tested without a Worker.
//
// These are the assertions that keep an MCP client working: the metadata documents say exactly what
// the spec's clients read, registration refuses what it must refuse, and PKCE verifies what it must
// verify. The end-to-end drive of the same code lives in __integration__/oauth-flow.test.ts.

import { describe, expect, it } from "vitest";
import {
  AUTHORIZE_PATH, OAuthProtocolError, REGISTER_PATH, TOKEN_PATH,
  authorizationServerMetadata, deriveCodeChallenge, formatScopeParameter, isAllowedRedirectUri,
  isValidPkceValue, parseScopeParameter, protectedResourceMetadata, timingSafeEqualStrings,
  validateRegistration, verifyPkce,
} from "../src/auth/oauth/protocol.js";
import { AGENT_SCOPES } from "@gadgets/workshop-shared/api";

const ORIGIN = "https://os.example";

describe("protected-resource metadata (RFC 9728)", () => {
  it("names this origin as both the resource and its authorization server", () => {
    const metadata = protectedResourceMetadata(ORIGIN);
    expect(metadata.resource).toBe(ORIGIN);
    expect(metadata.authorization_servers).toEqual([ORIGIN]);
    expect(metadata.bearer_methods_supported).toEqual(["header"]);
  });

  it("advertises exactly the AgentScope vocabulary", () => {
    // The point of the assertion: there is one scope vocabulary in this system. If someone adds a
    // scope, it appears here for free -- and if someone invents an OAuth-only scope, this fails.
    expect(protectedResourceMetadata(ORIGIN).scopes_supported).toEqual([...AGENT_SCOPES]);
  });
});

describe("authorization-server metadata (RFC 8414)", () => {
  const metadata = authorizationServerMetadata(ORIGIN);

  it("publishes absolute endpoint URLs under the issuer", () => {
    expect(metadata.issuer).toBe(ORIGIN);
    expect(metadata.authorization_endpoint).toBe(`${ORIGIN}${AUTHORIZE_PATH}`);
    expect(metadata.token_endpoint).toBe(`${ORIGIN}${TOKEN_PATH}`);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}${REGISTER_PATH}`);
  });

  it("offers only S256, only the code grant, and only public clients", () => {
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("does not advertise refresh tokens", () => {
    // v1 issues long-lived, revocable agent credentials instead; a client must not expect to
    // refresh one.
    expect(metadata.grant_types_supported).not.toContain("refresh_token");
    expect(metadata).not.toHaveProperty("refresh_endpoint");
  });
});

describe("redirect URI rules", () => {
  it("accepts https anywhere and http on loopback", () => {
    expect(isAllowedRedirectUri("https://client.example/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8976/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://[::1]:1234/cb")).toBe(true);
  });

  it("refuses plaintext http to anywhere else", () => {
    // The authorization code travels in this URL's query string.
    expect(isAllowedRedirectUri("http://client.example/callback")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.evil.example/cb")).toBe(false);
  });

  it("refuses a fragment, and anything that is not a URL", () => {
    expect(isAllowedRedirectUri("https://client.example/cb#frag")).toBe(false);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("")).toBe(false);
  });

  it("accepts a private-use application scheme (RFC 8252 §7.1)", () => {
    // A reverse-domain scheme is claimable by exactly one party, and the OS hands the redirect to a
    // locally installed app rather than putting it on a network.
    expect(isAllowedRedirectUri("com.example.app:/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("com.example.app:oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("app.myoplan.desktop://auth/cb")).toBe(true);
  });

  it("accepts the short editor schemes that predate that advice", () => {
    // These clients exist and are the reason this server has an OAuth flow at all.
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/cb")).toBe(true);
    expect(isAllowedRedirectUri("vscode://mcp/callback")).toBe(true);
    expect(isAllowedRedirectUri("zed://oauth/cb")).toBe(true);
  });

  it("still refuses anything that could be an open redirector or a script URL", () => {
    // Default-deny: an unrecognised bare scheme is not claimable by anyone in particular, so it is
    // not evidence that the redirect reaches the client that registered it.
    expect(isAllowedRedirectUri("myapp://cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirectUri("data:text/html,<script>")).toBe(false);
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
    expect(isAllowedRedirectUri("ftp://files.example/cb")).toBe(false);
    expect(isAllowedRedirectUri("ws://client.example/cb")).toBe(false);
    // And a private-use scheme still may not carry a fragment.
    expect(isAllowedRedirectUri("com.example.app:/cb#frag")).toBe(false);
  });
});

describe("dynamic client registration (RFC 7591)", () => {
  const good = { client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"] };

  it("accepts a minimal public-client registration", () => {
    const request = validateRegistration(good);
    expect(request.clientName).toBe("Claude Code");
    expect(request.redirectUris).toEqual(["http://localhost:33418/callback"]);
    expect(request.scopes).toBeUndefined();
  });

  it("requires a client_name, because that is what the user is shown", () => {
    expect(() => validateRegistration({ ...good, client_name: "   " }))
        .toThrow(OAuthProtocolError);
    expect(() => validateRegistration({ redirect_uris: good.redirect_uris }))
        .toThrow(/client_name is required/);
  });

  it("requires at least one acceptable redirect_uri", () => {
    expect(() => validateRegistration({ ...good, redirect_uris: [] }))
        .toThrow(/non-empty array/);
    expect(() => validateRegistration({ ...good, redirect_uris: ["http://evil.example/cb"] }))
        .toThrow(/must be an https URL/);
  });

  it("deduplicates redirect URIs", () => {
    const request = validateRegistration({
      ...good, redirect_uris: [good.redirect_uris[0], good.redirect_uris[0]],
    });
    expect(request.redirectUris).toHaveLength(1);
  });

  it("registers the supported subset of a client that asks for more (RFC 7591 §3.2.1)", () => {
    // The exact payload Claude Code sends. Asking for refresh_token is the normal shape for a
    // client that wants long-lived access; refusing it was the interop bug this test now pins.
    const request = validateRegistration({
      ...good, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(request.grantTypes).toEqual(["authorization_code"]);
    expect(request.responseTypes).toEqual(["code"]);
    expect(request.tokenEndpointAuthMethod).toBe("none");
  });

  it("defaults the registered metadata when the client declares none", () => {
    const request = validateRegistration(good);
    expect(request.grantTypes).toEqual(["authorization_code"]);
    expect(request.responseTypes).toEqual(["code"]);
    expect(request.tokenEndpointAuthMethod).toBe("none");
  });

  it("registers a public client whatever authentication the client would have preferred", () => {
    // There are no client secrets to issue, so this is not a negotiation with two outcomes -- but
    // it is not a reason to refuse the registration either. The response tells the client what it
    // got, which is how it learns not to send a secret to the token endpoint.
    expect(validateRegistration({ ...good, token_endpoint_auth_method: "client_secret_post" })
        .tokenEndpointAuthMethod).toBe("none");
    expect(() => validateRegistration({ ...good, token_endpoint_auth_method: 7 }))
        .toThrow(/must be a string/);
  });

  it("refuses a client that asks for none of what this server supports", () => {
    // This one genuinely could not complete a flow here, so 400 is the honest answer.
    expect(() => validateRegistration({ ...good, grant_types: ["refresh_token"] }))
        .toThrow(/must include authorization_code/);
    expect(() => validateRegistration({ ...good, grant_types: [] }))
        .toThrow(/must include authorization_code/);
    expect(() => validateRegistration({ ...good, response_types: ["token"] }))
        .toThrow(/must include "code"/);
    expect(() => validateRegistration({ ...good, grant_types: "authorization_code" }))
        .toThrow(/must be an array of strings/);
  });

  it("keeps the scopes it knows from a declared scope, and drops the rest", () => {
    // Registration-time scope is advisory; /oauth/authorize is where an unknown scope must fail.
    expect(validateRegistration({ ...good, scope: "read chat" }).scopes).toEqual(["read", "chat"]);
    expect(validateRegistration({ ...good, scope: "read wildcard" }).scopes).toEqual(["read"]);
    expect(validateRegistration({ ...good, scope: "wildcard" }).scopes).toBeUndefined();
    // ... but it still fails there:
    expect(() => parseScopeParameter("read wildcard")).toThrow(/Unknown scope/);
  });

  it("refuses a non-object body", () => {
    expect(() => validateRegistration("nope")).toThrow(/must be a JSON object/);
    expect(() => validateRegistration([good])).toThrow(/must be a JSON object/);
  });
});

describe("scope parameters", () => {
  it("canonicalizes order and drops duplicates", () => {
    // A stored grant must not depend on the order the client happened to send.
    expect(parseScopeParameter("chat read read build")).toEqual(["read", "build", "chat"]);
    expect(formatScopeParameter(["chat", "read"])).toBe("read chat");
  });

  it("rejects unknown scopes rather than dropping them", () => {
    expect(() => parseScopeParameter("read admin:all")).toThrow(OAuthProtocolError);
  });

  it("treats extra whitespace as delimiters", () => {
    expect(parseScopeParameter("  read   build  ")).toEqual(["read", "build"]);
  });
});

describe("PKCE (RFC 7636)", () => {
  it("accepts only the 43-128 character unreserved alphabet", () => {
    expect(isValidPkceValue("a".repeat(43))).toBe(true);
    expect(isValidPkceValue("a".repeat(128))).toBe(true);
    expect(isValidPkceValue("a".repeat(42))).toBe(false);
    expect(isValidPkceValue("a".repeat(129))).toBe(false);
    expect(isValidPkceValue("a".repeat(42) + "+")).toBe(false);
  });

  it("derives the challenge the RFC's own test vector expects", () => {
    // RFC 7636 Appendix B: the canonical verifier/challenge pair. If this passes, every conforming
    // client's S256 computation agrees with ours.
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        .resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("verifies a matching verifier and refuses everything else", async () => {
    const verifier = "verifier".padEnd(64, "x");
    const challenge = await deriveCodeChallenge(verifier);
    expect(await verifyPkce(verifier, challenge)).toBe(true);
    expect(await verifyPkce("wrong".padEnd(64, "y"), challenge)).toBe(false);
    // A verifier that is not even well-formed fails before hashing.
    expect(await verifyPkce("short", challenge)).toBe(false);
    // The `plain` downgrade -- sending the challenge as the verifier -- must not pass.
    expect(await verifyPkce(challenge.padEnd(43, "a"), challenge)).toBe(false);
  });

  it("compares in constant time, and still compares correctly", () => {
    expect(timingSafeEqualStrings("abc", "abc")).toBe(true);
    expect(timingSafeEqualStrings("abc", "abd")).toBe(false);
    expect(timingSafeEqualStrings("abc", "ab")).toBe(false);
  });
});
