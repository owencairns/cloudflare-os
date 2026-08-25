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
// **The refresh-token decision, and what makes it coherent.** Real MCP clients (Claude Code among
// them) register asking for `grant_types: ["authorization_code", "refresh_token"]`, because that is
// what a client wanting long-lived access normally has to ask for. We still do not implement
// refresh tokens -- the credential is already long-lived, so a refresh grant would buy nothing and
// cost a second expiry story -- but *asking* for one is no longer an error. Three things have to
// agree for that to be honest rather than merely permissive, and they do:
//
//   1. Registration accepts a superset. RFC 7591 §2 and §3.2.1 say the server registers what it
//      supports and *reports back what it registered*, which may differ from the request. So a
//      request naming `refresh_token` registers `["authorization_code"]` and the 201 response says
//      so. Only a request with no `authorization_code` at all is refused -- that client genuinely
//      cannot complete a flow here.
//   2. The metadata document advertises exactly what exists: `grant_types_supported` is
//      `["authorization_code"]`, and nothing anywhere implies refreshability.
//   3. The token response carries no `expires_in` and no `refresh_token`, and a client that sends
//      `grant_type=refresh_token` anyway gets RFC 6749 §5.2's `unsupported_grant_type` with a 400 --
//      the spec-correct answer, not a crash and not a confusing `invalid_request`.
//
// A client that reads any one of those three learns the truth; a client that reads none of them
// still works, because the credential it holds never needs refreshing.
//
// **Registration validation is a negotiation, not a spelling test.** The same principle governs
// every other piece of client metadata: `response_types`, `token_endpoint_auth_method` and the
// declared `scope` are narrowed to what this server supports and echoed back as registered, rather
// than 400ing a client whose only sin is being more capable than we are. `scope` at *registration*
// is advisory (RFC 7591 §2 -- "scopes the client can use"), so unknown entries are dropped there;
// `scope` at */oauth/authorize* is a real request, and an unknown entry still fails loudly, because
// that is the one place a typo would quietly issue a different grant than the user believes.
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

/**
 * The one grant, the one response type, and the one client authentication method this server
 * implements. Written once, here, because three separate places have to agree about them: the
 * metadata document, what registration narrows a client's request down to, and what the
 * registration response reports back as registered.
 */
export const SUPPORTED_GRANT_TYPES: readonly string[] = ["authorization_code"];
export const SUPPORTED_RESPONSE_TYPES: readonly string[] = ["code"];
export const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD = "none";

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
    response_types_supported: [...SUPPORTED_RESPONSE_TYPES],
    // No refresh_token grant: see the note at the top of this file. A client may *register* asking
    // for one; this document is the authoritative statement that it will never get one.
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    // `plain` is deliberately absent. OAuth 2.1 requires S256 for public clients, and offering
    // `plain` would let a client downgrade itself.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD],
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

/**
 * What a registration request says, *once narrowed to what this server actually registers*. The
 * `grantTypes` / `responseTypes` / `tokenEndpointAuthMethod` fields are not echoes of the request:
 * they are the registered values, which RFC 7591 §3.2.1 requires the 201 response to report and
 * which may be narrower than what the client asked for.
 */
export type RegistrationRequest = {
  clientName: string;
  redirectUris: string[];
  /** The scopes the client says it will ask for. Advisory: each authorization asks again. */
  scopes?: AgentScope[];
  /** Always `["authorization_code"]` today; see the refresh-token note at the top of this file. */
  grantTypes: string[];
  /** Always `["code"]` today. */
  responseTypes: string[];
  /** Always `"none"` today: this server issues no client secrets. */
  tokenEndpointAuthMethod: string;
};

/**
 * Longest `client_name` we will store and later show on the approval screen. A longer one is
 * truncated rather than refused -- the name is a label on a consent screen, not a capability, and
 * the registration response tells the client exactly what was stored.
 */
const MAX_CLIENT_NAME = 120;

/**
 * Schemes that are never acceptable as a redirect target, listed explicitly so the intent is
 * visible even though the rule below is default-deny anyway. `http`/`https` are handled separately;
 * the rest are either web-facing (and so could make this an open redirector) or are script/data
 * URLs that must never be navigated to with an authorization code attached.
 */
const FORBIDDEN_REDIRECT_SCHEMES = new Set([
  "ftp", "ws", "wss", "file", "data", "blob", "javascript", "vbscript", "about", "mailto",
  "view-source", "filesystem", "chrome", "chrome-extension",
]);

/**
 * Well-known desktop-client schemes that are not reverse-domain shaped. RFC 8252 §7.1 asks for a
 * scheme the client controls via a domain it owns; these editors shipped short schemes before that
 * advice settled, and refusing them would refuse the clients this server exists to serve.
 */
const KNOWN_APP_REDIRECT_SCHEMES = new Set([
  "vscode", "vscode-insiders", "vscodium", "code-oss", "cursor", "windsurf", "zed", "trae",
  "jetbrains", "idea", "fleet", "claude", "claude-code",
]);
/** Registering more than a handful of redirect URIs is a sign of a confused (or hostile) client. */
const MAX_REDIRECT_URIS = 8;

/**
 * Whether a redirect URI may be registered.
 *
 * Three shapes are allowed, and no others:
 *
 *   - `https://...`, for a hosted client;
 *   - `http://localhost...` / `http://127.0.0.1...` / `http://[::1]...`, for a client that spins up
 *     a loopback listener, which is how most desktop MCP clients complete the flow;
 *   - a **private-use URI scheme** per RFC 8252 §7.1 -- `com.example.app:/callback` -- plus the
 *     handful of short editor schemes (`vscode:`, `cursor:`, ...) that predate that advice. The OS
 *     hands one of these to a locally installed application, so the code never crosses a network.
 *
 * Everything else is refused, and the rule is default-deny rather than a blocklist. In particular
 * plain `http` to any host but loopback is refused, because the authorization code would cross the
 * network in clear text; and a bare one-word scheme this server has never heard of is refused,
 * because nothing about it can be traced to an owner -- an unclaimable scheme is a scheme an
 * attacker's app can register too.
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
  if (url.protocol === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
        || url.hostname === "::1";
  }

  let scheme = url.protocol.slice(0, -1).toLowerCase();
  if (FORBIDDEN_REDIRECT_SCHEMES.has(scheme)) return false;
  // RFC 8252 §7.1: a scheme derived from a domain name the client controls, which in practice means
  // it contains a dot. That is what makes it *private-use* rather than a name anyone may squat.
  if (scheme.includes(".")) return true;
  return KNOWN_APP_REDIRECT_SCHEMES.has(scheme);
}

/**
 * Narrow a client's declared list-valued metadata to what this server implements.
 *
 * RFC 7591 §2 lets the server register values that differ from those requested, and §3.2.1 makes
 * the response the authoritative statement of what was registered. So the rule here is *intersect,
 * do not match*: a client asking for more than we do gets the part we can do, and only a client
 * asking for none of what we do is turned away -- it is the one that could never complete a flow.
 */
function narrowDeclaredMetadata(
    raw: unknown, supported: readonly string[], field: string,
    description: string): string[] {
  if (raw === undefined) return [...supported];
  if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string")) {
    throw new OAuthProtocolError(
        "invalid_client_metadata", `${field} must be an array of strings.`);
  }
  let registered = supported.filter(entry => (raw as string[]).includes(entry));
  if (registered.length === 0) {
    throw new OAuthProtocolError("invalid_client_metadata", description);
  }
  return registered;
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
  // Truncated, not refused: the approval screen has a finite amount of room, but a long name is
  // not a reason a connection cannot be made. The response reports what was actually stored.
  if (clientName.length > MAX_CLIENT_NAME) clientName = clientName.slice(0, MAX_CLIENT_NAME);

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
          "Each redirect_uri must be an https URL, an http URL on localhost, or a private-use " +
          "application scheme (RFC 8252 §7.1).");
    }
    if (!redirectUris.includes(candidate)) redirectUris.push(candidate);
  }

  // RFC 7591 §2 / §3.2.1: a client declares what it can do, the server registers the part it
  // supports, and the response reports what was registered. A client asking for `refresh_token`
  // alongside `authorization_code` is the normal case, not an error -- see the note at the top of
  // this file for why it still never receives a refresh token.
  let grantTypes = narrowDeclaredMetadata(
      record["grant_types"], SUPPORTED_GRANT_TYPES, "grant_types",
      "grant_types must include authorization_code, the only grant this server supports.");
  let responseTypes = narrowDeclaredMetadata(
      record["response_types"], SUPPORTED_RESPONSE_TYPES, "response_types",
      "response_types must include \"code\", the only response type this server supports.");

  // Not a negotiation with more than one outcome: this server has no client secrets to issue, so
  // every registration is a public client whatever the request preferred. Reporting `"none"` back
  // is how the client learns not to send one at the token endpoint. Only a value that is not even
  // a string is refused, since that is a malformed request rather than an unsupported preference.
  let rawAuthMethod = record["token_endpoint_auth_method"];
  if (rawAuthMethod !== undefined && typeof rawAuthMethod !== "string") {
    throw new OAuthProtocolError(
        "invalid_client_metadata", "token_endpoint_auth_method must be a string.");
  }

  // Registration-time `scope` is advisory (RFC 7591 §2: the scopes the client *can* use), and each
  // authorization asks for scopes again and is checked strictly there. So an unknown entry is
  // dropped here rather than failing the registration -- a client that names some scope from
  // another server's vocabulary should still be able to connect.
  let scopes: AgentScope[] | undefined;
  let rawScope = record["scope"];
  if (typeof rawScope === "string" && rawScope.trim()) {
    let declared = rawScope.split(/\s+/).filter(part => part.length > 0);
    let known = AGENT_SCOPES.filter(scope => declared.includes(scope));
    if (known.length > 0) scopes = known;
  }

  return {
    clientName, redirectUris, scopes, grantTypes, responseTypes,
    tokenEndpointAuthMethod: SUPPORTED_TOKEN_ENDPOINT_AUTH_METHOD,
  };
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
