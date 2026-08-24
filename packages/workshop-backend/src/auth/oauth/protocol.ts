// The pure protocol layer of this deployment's OAuth 2.1 authorization server: the metadata
// documents, the registration request's validation rules, PKCE verification, and the error shapes.
//
// Everything here is a function of its arguments -- no storage, no `Request`, no `Env` -- so the
// wire contract an MCP client depends on is testable without a Worker, and the pieces that decide
// what a client may register are in one readable place rather than spread through a handler.
//
// **What this server is.** The narrowest thing that satisfies the MCP authorization spec:
//
//   - public clients only (PKCE `S256`, no client secret, `token_endpoint_auth_method: "none"`);
//   - one grant, `authorization_code`; one response type, `code`;
//   - no refresh tokens. The access credential this server issues *is* an agent credential
//     (`mpk_...`) minted by `UserDurableObject.mintAgentCredential()`, and those are long-lived and
//     revocable exactly like a browser session. A refresh token would add a second expiry story for
//     no gain, so `expires_in` is omitted from the token response and clients hold the credential
//     until the user revokes it from Settings.
//
// The scope vocabulary is `AgentScope` -- the same four scopes the tool seam enforces. There is no
// OAuth-specific scope namespace to translate.

import {
  AGENT_SCOPES, isAgentScope, type AgentScope,
} from "@gadgets/workshop-shared/api";

/** RFC 9728: where a resource server publishes which authorization servers protect it. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
/** RFC 8414: where an authorization server publishes its endpoints. */
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";

/**
 * The frontend route that renders the approval screen. `/oauth/authorize` redirects here with an
 * opaque request id; the page reads the request and posts the decision back over the ordinary
 * authenticated RPC channel, which is what makes "the user must be logged in" free -- the SPA
 * already shows its login page for any authenticated route.
 */
export const APPROVAL_PAGE_PATH = "/oauth/approve";

/** How long a pending authorization request stays claimable, from the redirect to the decision. */
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;

/** How long an issued authorization code may be exchanged. Short, per OAuth 2.1's guidance. */
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The scopes an authorization request is read as asking for when it names none. OAuth lets the
 * server pick a default; we pick "everything an MCP client normally needs" minus `admin`, which
 * must always be asked for explicitly because it is the one scope that reaches the deployment
 * rather than the user's own workspaces.
 */
export const DEFAULT_REQUESTED_SCOPES: readonly AgentScope[] = ["read", "build", "chat"];

// ---------------------------------------------------------------------------------------------
// Metadata documents
// ---------------------------------------------------------------------------------------------

/** RFC 9728 §2, as served at {@link PROTECTED_RESOURCE_METADATA_PATH}. */
export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
};

/** RFC 8414 §2, as served at {@link AUTHORIZATION_SERVER_METADATA_PATH}. */
export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  response_modes_supported: string[];
};

/**
 * This deployment protects exactly one resource -- itself -- and is its own authorization server,
 * so `resource` and the single entry of `authorization_servers` are both the origin. A client that
 * fetches this learns where to run the flow without any configuration from the user beyond the URL
 * they already pasted.
 */
export function protectedResourceMetadata(origin: string): ProtectedResourceMetadata {
  return {
    resource: origin,
    authorization_servers: [origin],
    scopes_supported: [...AGENT_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

export function authorizationServerMetadata(origin: string): AuthorizationServerMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    scopes_supported: [...AGENT_SCOPES],
    response_types_supported: ["code"],
    // No refresh_token grant: see the note at the top of this file.
    grant_types_supported: ["authorization_code"],
    // `plain` is deliberately absent. OAuth 2.1 requires S256 for public clients, and offering
    // `plain` would let a client downgrade itself.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    response_modes_supported: ["query"],
  };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** An RFC 6749 §5.2 / §4.1.2.1 error, carried either as JSON or as redirect parameters. */
export class OAuthProtocolError extends Error {
  constructor(
      readonly code: string,
      readonly description: string,
      /** HTTP status for the JSON rendering. Redirected errors ignore it. */
      readonly status: number = 400) {
    super(`${code}: ${description}`);
    this.name = "OAuthProtocolError";
  }

  toJson(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

// ---------------------------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------------------------

/** What a registration request may say, once validated. */
export type RegistrationRequest = {
  clientName: string;
  redirectUris: string[];
  /** The scopes the client says it will ask for. Advisory: each authorization asks again. */
  scopes?: AgentScope[];
};

/** Longest `client_name` we will store and later show on the approval screen. */
const MAX_CLIENT_NAME = 120;
/** Registering more than a handful of redirect URIs is a sign of a confused (or hostile) client. */
const MAX_REDIRECT_URIS = 8;

/**
 * Whether a redirect URI may be registered.
 *
 * Two shapes are allowed, and no others:
 *
 *   - `https://...`, for a hosted client;
 *   - `http://localhost...` / `http://127.0.0.1...` / `http://[::1]...`, for a client that spins up
 *     a loopback listener, which is how every desktop MCP client completes the flow.
 *
 * Plain `http` to any other host is refused: the authorization code would cross the network in
 * clear text. Custom application schemes (`vscode://`, `cursor://`) are *also* refused today --
 * see the deferral note in the branch's report; permitting them is a change to this function alone.
 *
 * A fragment is refused outright (RFC 6749 §3.1.2), since the redirect appends query parameters.
 */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
      || url.hostname === "::1";
}

/**
 * Validate a parsed registration body. Throws {@link OAuthProtocolError} with RFC 7591's own error
 * codes (`invalid_client_metadata`, `invalid_redirect_uri`) so a client can tell which field it got
 * wrong -- registration is unauthenticated, but nothing here is a secret.
 */
export function validateRegistration(body: unknown): RegistrationRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OAuthProtocolError(
        "invalid_client_metadata", "The registration body must be a JSON object.");
  }
  let record = body as Record<string, unknown>;

  let rawName = record["client_name"];
  let clientName = typeof rawName === "string" ? rawName.trim() : "";
  if (!clientName) {
    throw new OAuthProtocolError(
        "invalid_client_metadata",
        "client_name is required: it is what the user sees when approving this connection.");
  }
  if (clientName.length > MAX_CLIENT_NAME) {
    throw new OAuthProtocolError(
        "invalid_client_metadata", `client_name must be at most ${MAX_CLIENT_NAME} characters.`);
  }

  let rawUris = record["redirect_uris"];
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    throw new OAuthProtocolError(
        "invalid_redirect_uri", "redirect_uris must be a non-empty array.");
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthProtocolError(
        "invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect_uris may be registered.`);
  }
  let redirectUris: string[] = [];
  for (let candidate of rawUris) {
    if (typeof candidate !== "string" || !isAllowedRedirectUri(candidate)) {
      throw new OAuthProtocolError(
          "invalid_redirect_uri",
          "Each redirect_uri must be an https URL, or an http URL on localhost.");
    }
    if (!redirectUris.includes(candidate)) redirectUris.push(candidate);
  }

  // RFC 7591 lets a client declare these; we accept only the ones this server implements rather
  // than silently registering a client that can never complete a flow.
  let grantTypes = record["grant_types"];
  if (grantTypes !== undefined) {
    if (!Array.isArray(grantTypes) ||
        grantTypes.some(grant => grant !== "authorization_code")) {
      throw new OAuthProtocolError(
          "invalid_client_metadata",
          "This server supports only the authorization_code grant.");
    }
  }
  let responseTypes = record["response_types"];
  if (responseTypes !== undefined) {
    if (!Array.isArray(responseTypes) || responseTypes.some(type => type !== "code")) {
      throw new OAuthProtocolError(
          "invalid_client_metadata", "This server supports only the \"code\" response type.");
    }
  }
  let authMethod = record["token_endpoint_auth_method"];
  if (authMethod !== undefined && authMethod !== "none") {
    throw new OAuthProtocolError(
        "invalid_client_metadata",
        "This server registers public clients only (token_endpoint_auth_method \"none\").");
  }

  let scopes: AgentScope[] | undefined;
  let rawScope = record["scope"];
  if (typeof rawScope === "string" && rawScope.trim()) {
    scopes = parseScopeParameter(rawScope, "invalid_client_metadata");
  }

  return { clientName, redirectUris, scopes };
}

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/**
 * Parse an OAuth `scope` parameter (space-delimited) into `AgentScope`s, rejecting anything this
 * deployment does not define. Rejecting rather than dropping is the same rule
 * `mintAgentCredential()` applies: a typo must fail loudly, not quietly issue a weaker grant.
 */
export function parseScopeParameter(
    value: string, errorCode: string = "invalid_scope"): AgentScope[] {
  let requested = value.split(/\s+/).filter(part => part.length > 0);
  let unknown = requested.filter(scope => !isAgentScope(scope));
  if (unknown.length > 0) {
    throw new OAuthProtocolError(errorCode, `Unknown scope(s): ${unknown.join(", ")}`);
  }
  // Dedupe and present in the canonical order, so a stored grant never depends on request order.
  let deduped = new Set(requested);
  return AGENT_SCOPES.filter(scope => deduped.has(scope));
}

/** Render scopes back onto the wire, canonically ordered. */
export function formatScopeParameter(scopes: readonly AgentScope[]): string {
  return AGENT_SCOPES.filter(scope => scopes.includes(scope)).join(" ");
}

// ---------------------------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------------------------

/** A `code_challenge` is 43-128 characters of unreserved base64url alphabet (RFC 7636 §4.2). */
const PKCE_VALUE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** True if `value` is a syntactically valid `code_challenge` or `code_verifier`. */
export function isValidPkceValue(value: string): boolean {
  return PKCE_VALUE.test(value);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytes.toBase64().replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** The `S256` transformation: base64url(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  let digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Verify a `code_verifier` against the `code_challenge` recorded when the code was issued.
 *
 * Compared in constant time. The challenge is not a secret (it travelled in a URL), but the
 * verifier is, and a timing oracle on the comparison would leak it a character at a time.
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!isValidPkceValue(verifier)) return false;
  let derived = await deriveCodeChallenge(verifier);
  return timingSafeEqualStrings(derived, challenge);
}

/** Constant-time string comparison over the ASCII the OAuth wire format allows. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

/** A random, URL-safe opaque identifier (client ids, request ids, authorization codes). */
export function randomToken(prefix: string, bytes: number = 24): string {
  let raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return `${prefix}${base64UrlEncode(raw)}`;
}
