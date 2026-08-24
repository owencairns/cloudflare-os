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

  it("refuses custom application schemes today", () => {
    // Deliberate, and the single place to change if desktop clients need it.
    expect(isAllowedRedirectUri("cursor://anysphere.cursor-mcp/oauth/cb")).toBe(false);
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

  it("refuses a client declaring capabilities this server does not implement", () => {
    expect(() => validateRegistration({ ...good, grant_types: ["refresh_token"] }))
        .toThrow(/authorization_code grant/);
    expect(() => validateRegistration({ ...good, response_types: ["token"] }))
        .toThrow(/"code" response type/);
    expect(() => validateRegistration({ ...good, token_endpoint_auth_method: "client_secret_post" }))
        .toThrow(/public clients only/);
  });

  it("parses a declared scope, and rejects an unknown one", () => {
    expect(validateRegistration({ ...good, scope: "read chat" }).scopes).toEqual(["read", "chat"]);
    expect(() => validateRegistration({ ...good, scope: "read wildcard" }))
        .toThrow(/Unknown scope/);
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
