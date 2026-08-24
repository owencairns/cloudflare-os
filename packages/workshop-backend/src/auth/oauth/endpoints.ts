// The HTTP surface of the authorization server: the two metadata documents, dynamic client
// registration, the authorization endpoint, and the token endpoint.
//
// The chain an MCP client walks, and where each step lands:
//
//   1. POST /mcp with no credential            -> 401 + WWW-Authenticate naming (2)   [src/mcp/auth.ts]
//   2. GET  /.well-known/oauth-protected-resource -> "the authorization server is this origin"
//   3. GET  /.well-known/oauth-authorization-server -> the three endpoint URLs below
//   4. POST /oauth/register                    -> a client_id (no secret; public client + PKCE)
//   5. GET  /oauth/authorize                   -> 302 to the SPA's approval page
//        ... the user approves in the browser; the SPA calls back over the ordinary authenticated
//        RPC channel (`decideAgentAuthorization`), which issues the code and returns the redirect
//        URL. That is the one step not served here: it needs the user's session, and the SPA
//        already knows how to obtain one.
//   6. POST /oauth/token                       -> an `mpk_` agent credential
//   7. POST /mcp with that credential          -> the existing agent-credential validator
//
// Step 7 needs no new code: the token endpoint mints through `mintAgentCredential()`, so what it
// returns is an ordinary agent credential and the validator that already exists owns it.

import {
  AUTHORIZATION_SERVER_METADATA_PATH, APPROVAL_PAGE_PATH, AUTHORIZE_PATH,
  DEFAULT_REQUESTED_SCOPES, OAuthProtocolError, PROTECTED_RESOURCE_METADATA_PATH, REGISTER_PATH,
  TOKEN_PATH, authorizationServerMetadata, formatScopeParameter, isValidPkceValue,
  parseScopeParameter, protectedResourceMetadata, validateRegistration, verifyPkce,
} from "./protocol.js";
import type { OAuthProvider } from "./provider.js";
import type { UserDurableObject } from "../../user.js";
import { formatAgentCredential } from "../credentials.js";
import { createWorkshopLogger } from "../../observability.js";

const logger = createWorkshopLogger("workshop.oauth");

/** What the OAuth endpoints need from the surrounding fetch handler. */
export type OAuthDeps = {
  provider: DurableObjectNamespace<OAuthProvider>;
  users: DurableObjectNamespace<UserDurableObject>;
};

/**
 * True if this request belongs to the authorization server, so `server.ts` can route it before the
 * SPA gets a look.
 *
 * The two metadata paths match by *prefix*, not equality. RFC 9728 §3.1 and the MCP spec direct a
 * client whose resource has a path (`https://os.example/mcp`) to insert that path into the
 * well-known URL -- `/.well-known/oauth-protected-resource/mcp`. This deployment's resource is the
 * bare origin, so every such variant describes the same thing and is answered identically, rather
 * than 404ing a client that followed the spec's other branch.
 */
export function isOAuthPath(pathname: string): boolean {
  return pathname === PROTECTED_RESOURCE_METADATA_PATH ||
      pathname.startsWith(PROTECTED_RESOURCE_METADATA_PATH + "/") ||
      pathname === AUTHORIZATION_SERVER_METADATA_PATH ||
      pathname.startsWith(AUTHORIZATION_SERVER_METADATA_PATH + "/") ||
      pathname === REGISTER_PATH || pathname === AUTHORIZE_PATH || pathname === TOKEN_PATH;
}

/**
 * These endpoints are read (and posted to) by browser-hosted MCP clients from arbitrary origins,
 * which is exactly what OAuth's own security model assumes -- the interesting secrets are the
 * `code_verifier` and the resulting credential, neither of which a cross-origin reader can obtain.
 * `Access-Control-Allow-Origin: *` is what the spec's clients expect; note that it makes credentials
 * mode impossible, which is fine because none of these endpoints uses cookies.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status: number = 200,
              extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Metadata is stable but not immutable; a short cache keeps a client's repeated discovery
      // cheap without pinning a stale document across a deployment.
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function errorJson(error: OAuthProtocolError): Response {
  return new Response(JSON.stringify(error.toJson(), null, 2), {
    status: error.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/** Answers a CORS preflight. No credential is presented on one, so nothing is authorized here. */
function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ---------------------------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------------------------

export async function handleOAuthRequest(
    req: Request, url: URL, deps: OAuthDeps): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  try {
    let path = url.pathname;

    if (path === PROTECTED_RESOURCE_METADATA_PATH ||
        path.startsWith(PROTECTED_RESOURCE_METADATA_PATH + "/")) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      return json(protectedResourceMetadata(url.origin));
    }

    if (path === AUTHORIZATION_SERVER_METADATA_PATH ||
        path.startsWith(AUTHORIZATION_SERVER_METADATA_PATH + "/")) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      return json(authorizationServerMetadata(url.origin));
    }

    if (path === REGISTER_PATH) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return await handleRegister(req, deps);
    }

    if (path === AUTHORIZE_PATH) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      return await handleAuthorize(url, deps);
    }

    if (path === TOKEN_PATH) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return await handleToken(req, deps);
    }

    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof OAuthProtocolError) return errorJson(error);
    logger.warn("oauth request failed", { event: "oauth.request.failed", error });
    return errorJson(new OAuthProtocolError(
        "server_error", "The authorization server failed to handle this request.", 500));
  }
}

function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: "invalid_request" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: `${allowed}, OPTIONS`, ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------------------------
// /oauth/register  (RFC 7591)
// ---------------------------------------------------------------------------------------------

async function handleRegister(req: Request, deps: OAuthDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new OAuthProtocolError("invalid_client_metadata", "The request body must be JSON.");
  }

  let request = validateRegistration(body);
  let record = await deps.provider.getByName("").registerClient(request);

  logger.info("oauth client registered", {
    event: "oauth.client.registered", clientId: record.clientId,
  });

  // RFC 7591 §3.2.1: 201, `client_id`, and the metadata as registered (which may differ from what
  // was sent -- here, only in that unspecified fields are filled in with this server's one answer).
  return json({
    client_id: record.clientId,
    client_id_issued_at: Math.floor(record.createdAt.valueOf() / 1000),
    client_name: record.clientName,
    redirect_uris: record.redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(record.scopes ? { scope: formatScopeParameter(record.scopes) } : {}),
  }, 201, { "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------------------------------------
// /oauth/authorize  (RFC 6749 §4.1.1 + RFC 7636)
// ---------------------------------------------------------------------------------------------

/**
 * Validates an authorization request and hands the browser to the approval page.
 *
 * The split between "answer with an error page" and "redirect the error to the client" is RFC 6749
 * §4.1.2.1 and it matters: an unverified `client_id` or `redirect_uri` must **not** be redirected
 * to, because doing so would make this endpoint an open redirector that an attacker can aim
 * anywhere. Everything after those two are verified is the client's problem, so it goes back to the
 * client where its error handling can see it.
 */
async function handleAuthorize(url: URL, deps: OAuthDeps): Promise<Response> {
  let params = url.searchParams;
  let provider = deps.provider.getByName("");

  let clientId = params.get("client_id");
  if (!clientId) {
    throw new OAuthProtocolError("invalid_request", "client_id is required.");
  }
  let client = await provider.getClient(clientId);
  if (!client) {
    throw new OAuthProtocolError(
        "invalid_client",
        "Unknown client_id. Register with this authorization server before authorizing.");
  }

  // An omitted redirect_uri is allowed only when the registration is unambiguous (RFC 6749 §3.1.2.3).
  let redirectUri = params.get("redirect_uri") ?? undefined;
  if (redirectUri === undefined) {
    if (client.redirectUris.length !== 1) {
      throw new OAuthProtocolError(
          "invalid_request",
          "redirect_uri is required when the client registered more than one.");
    }
    redirectUri = client.redirectUris[0]!;
  } else if (!client.redirectUris.includes(redirectUri)) {
    // Exact string match against what was registered -- never a prefix or origin comparison, which
    // is the classic way this check is defeated.
    throw new OAuthProtocolError(
        "invalid_request", "redirect_uri does not match a registered redirect URI.");
  }

  // From here the client is verified, so failures are reported by redirecting to it.
  let state = params.get("state") ?? undefined;
  let redirectError = (code: string, description: string) =>
      redirectResponse(buildRedirect(redirectUri!, { error: code, error_description: description },
                                     state));

  if ((params.get("response_type") ?? "") !== "code") {
    return redirectError("unsupported_response_type", "Only response_type=code is supported.");
  }

  let codeChallenge = params.get("code_challenge") ?? "";
  let method = params.get("code_challenge_method") ?? "";
  if (!codeChallenge) {
    return redirectError("invalid_request", "PKCE is required: send code_challenge.");
  }
  if (method !== "S256") {
    // Including the omitted case: OAuth 2.1 defaults `plain`, which this server does not accept.
    return redirectError(
        "invalid_request", "code_challenge_method must be S256.");
  }
  if (!isValidPkceValue(codeChallenge)) {
    return redirectError("invalid_request", "code_challenge is malformed.");
  }

  let requestedScopes;
  try {
    let raw = params.get("scope");
    requestedScopes = raw && raw.trim()
        ? parseScopeParameter(raw)
        : [...DEFAULT_REQUESTED_SCOPES];
  } catch (error) {
    if (!(error instanceof OAuthProtocolError)) throw error;
    return redirectError(error.code, error.description);
  }
  if (requestedScopes.length === 0) {
    return redirectError("invalid_scope", "At least one scope must be requested.");
  }

  let requestId = await provider.beginAuthorization({
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri,
    codeChallenge,
    state,
    resource: params.get("resource") ?? undefined,
    requestedScopes,
  });

  // The approval page is a frontend route, so this redirect is same-origin and the SPA's existing
  // "show the login page for an authenticated route" behaviour is what gates it. There is no
  // separate return-path dance: the URL the user is sent to is the URL they end up on after
  // logging in, because it never left the client-side router.
  let approval = new URL(APPROVAL_PAGE_PATH, url.origin);
  approval.searchParams.set("request", requestId);
  return redirectResponse(approval.toString());
}

/** Appends parameters to a redirect URI, preserving any query string it already carries. */
function buildRedirect(
    redirectUri: string, params: Record<string, string>, state?: string): string {
  let target = new URL(redirectUri);
  for (let [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  // RFC 6749 §4.1.2: state is echoed verbatim on both success and error, and is the client's only
  // CSRF defence, so it is set last and never conditionally.
  if (state !== undefined) target.searchParams.set("state", state);
  return target.toString();
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", ...CORS_HEADERS },
  });
}

/**
 * Builds the success redirect for an approved request. Exported because the approval decision is
 * made over RPC (see `AuthenticatedApi.decideAgentAuthorization`), not by this module's handler --
 * but the URL it produces is part of the same wire contract, so it is written once, here.
 */
export function buildAuthorizationRedirect(
    redirectUri: string, code: string, state?: string): string {
  return buildRedirect(redirectUri, { code }, state);
}

/** Builds the denial redirect. `access_denied` is RFC 6749's code for "the user said no". */
export function buildDenialRedirect(redirectUri: string, state?: string): string {
  return buildRedirect(redirectUri,
      { error: "access_denied", error_description: "The user declined this connection." }, state);
}

// ---------------------------------------------------------------------------------------------
// /oauth/token  (RFC 6749 §4.1.3)
// ---------------------------------------------------------------------------------------------

async function handleToken(req: Request, deps: OAuthDeps): Promise<Response> {
  // Read as form data rather than as text: RFC 6749 §4.1.3 specifies
  // `application/x-www-form-urlencoded`, and letting the runtime decode it means the charset and
  // percent-encoding rules are the platform's rather than ours.
  let form = new URLSearchParams();
  try {
    for (let [key, value] of await req.formData()) {
      if (typeof value === "string") form.append(key, value);
    }
  } catch {
    throw new OAuthProtocolError(
        "invalid_request", "The token request must be application/x-www-form-urlencoded.");
  }

  let grantType = form.get("grant_type");
  if (grantType !== "authorization_code") {
    throw new OAuthProtocolError(
        "unsupported_grant_type",
        "Only the authorization_code grant is supported; this server issues no refresh tokens.");
  }

  let code = form.get("code");
  let clientId = form.get("client_id");
  let codeVerifier = form.get("code_verifier");
  if (!code || !clientId || !codeVerifier) {
    throw new OAuthProtocolError(
        "invalid_request", "code, client_id and code_verifier are all required.");
  }
  // Public clients authenticate with PKCE alone; a client presenting a secret is a client that has
  // misread this server's metadata, and silently ignoring it would hide that.
  if (form.get("client_secret")) {
    throw new OAuthProtocolError(
        "invalid_client", "This server registers public clients; do not send a client_secret.",
        401);
  }

  let provider = deps.provider.getByName("");
  let result = await provider.consumeCode(code, clientId, form.get("redirect_uri") ?? undefined);
  if (!result.ok) {
    throw new OAuthProtocolError(result.error, result.description);
  }
  let grant = result.record;

  if (!await verifyPkce(codeVerifier, grant.codeChallenge)) {
    // The code is already spent by consumeCode(), so a wrong verifier cannot be retried against it.
    throw new OAuthProtocolError(
        "invalid_grant", "The code_verifier does not match the code_challenge.");
  }

  // **The issuance point.** Everything above was protocol; this line is the only place an OAuth
  // flow creates authority, and it creates exactly the same kind of record the rest of the system
  // already knows how to check, list and revoke.
  let secret = await deps.users.getByName(grant.username)
      .mintAgentCredential(grant.clientName, grant.scopes);

  logger.info("oauth credential issued", {
    event: "oauth.token.issued", clientId: grant.clientId, scopes: grant.scopes.join(" "),
  });

  // No `expires_in` and no `refresh_token`: the credential is long-lived and revocable from
  // Settings, exactly like a browser session. See the note at the top of protocol.ts.
  return new Response(JSON.stringify({
    access_token: formatAgentCredential(grant.username, secret),
    token_type: "Bearer",
    scope: formatScopeParameter(grant.scopes),
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // RFC 6749 §5.1 requires both on a token response.
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      ...CORS_HEADERS,
    },
  });
}
