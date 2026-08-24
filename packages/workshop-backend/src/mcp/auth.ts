// Authenticating a request to `/mcp`, and the challenge that starts OAuth discovery when it isn't
// authenticated.
//
// **Where this is going.** External agents will authenticate to `/mcp` via the MCP authorization
// spec: the 401 below carries a `WWW-Authenticate` header naming this deployment's
// protected-resource metadata, the client fetches that, discovers the authorization server, and
// completes an authorization-code + PKCE flow (registering itself dynamically if it has no client
// id). Bearer tokens issued that way carry the scopes the user approved.
//
// **Where it is today.** None of that exists yet -- it is the next branch. What exists is the
// *shape* it will slot into:
//
//   - Credential validation is a list (`CREDENTIAL_VALIDATORS`). Today it holds one entry, the
//     session token the web UI already issues, which is what makes this endpoint testable now. An
//     OAuth validator is one more entry; nothing else moves.
//   - Every unauthenticated request already answers with the spec's challenge, pointing at
//     `/.well-known/oauth-protected-resource`. That path 404s until the next branch serves it, but
//     the header a client keys off is correct from day one, so adding the metadata endpoints is
//     purely additive.
//   - Whatever a validator returns is an `McpPrincipal` carrying `scopes`. A session token's scopes
//     are `null`, meaning "unscoped, everything the user can do" -- distinct from `[]`, which an
//     OAuth credential with no approved scopes would carry. Tool dispatch already consults this
//     (see mcp/tools.ts `authorizeTool`), so scoped credentials become enforceable without
//     touching the tool table.

import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { mcpResponse } from "@gadgets/mcp-server/transport";

/** Where the protected-resource metadata will live (RFC 9728). Served by the OAuth branch. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/** The `realm` a challenge advertises. Cosmetic, but clients display it during consent. */
const AUTH_REALM = "MyoPlan OS";

/**
 * How the caller proved who they are. Recorded because the two classes will not stay
 * interchangeable: an OAuth credential is scoped and revocable per client, a session token is the
 * user's whole account.
 */
export type McpCredentialKind = "session-token" | "oauth";

/** An authenticated caller and the capability object their tools run against. */
export type McpPrincipal = {
  kind: McpCredentialKind;
  /**
   * Scopes the credential carries, or `null` for an unscoped credential (the user's full
   * authority). See the note at the top of this file: `null` and `[]` mean different things.
   */
  scopes: readonly string[] | null;
  /**
   * The same `AuthenticatedApi` the web UI holds -- not a parallel API surface. Every tool reaches
   * the instance through this and the stubs it hands out.
   */
  api: AuthenticatedApi;
};

/** What the auth layer needs from the request's environment to validate a credential. */
export type McpAuthDeps = {
  /**
   * Runs `PublicApi.authenticate` semantics for a credential -- i.e. the same call the browser
   * makes -- returning the authenticated capability object.
   */
  authenticateSessionToken: (token: string) => Promise<AuthenticatedApi>;
};

export type McpAuthResult =
    | { ok: true; principal: McpPrincipal }
    | { ok: false; response: Response };

/**
 * One way of turning a `Bearer` credential into a principal. The list below is ordered; the first
 * validator whose `matches` accepts the credential owns it, and its failure is the request's
 * failure (we never fall through to a second validator, which would turn a wrong password into a
 * confusing "unsupported credential").
 */
type CredentialValidator = {
  kind: McpCredentialKind;
  matches: (credential: string) => boolean;
  authenticate: (credential: string, deps: McpAuthDeps) => Promise<McpPrincipal>;
};

const CREDENTIAL_VALIDATORS: readonly CredentialValidator[] = [
  {
    kind: "session-token",
    // The web UI's session token is `username:token` -- exactly one colon, both halves non-empty.
    // An OAuth access token will not look like this, which is what lets the two coexist in one
    // `Authorization: Bearer` header once the OAuth validator joins the list.
    matches: (credential) => {
      let parts = credential.split(":");
      return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
    },
    authenticate: async (credential, deps) => ({
      kind: "session-token",
      // A session token is the user's whole account: unscoped.
      scopes: null,
      api: await deps.authenticateSessionToken(credential),
    }),
  },
  // ==> The OAuth validator lands here. It will match an opaque bearer token, verify it against the
  //     authorization server's introspection (or its own signature), and return
  //     `{kind: "oauth", scopes: <approved scopes>, api}`.
];

/** Parses `Authorization: Bearer <credential>`, case-insensitively on the scheme. */
export function parseBearerCredential(req: Request): string | null {
  let header = req.headers.get("Authorization");
  if (!header) return null;
  let match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() || null : null;
}

/**
 * Builds the `WWW-Authenticate` value for a 401. `resource_metadata` is the hook the MCP
 * authorization spec defines: a client that gets this fetches the named document, learns which
 * authorization server to talk to, and runs the code+PKCE flow against it.
 */
export function buildAuthenticateChallenge(
    resourceOrigin: string, failure?: { error: string; description: string }): string {
  let parts = [
    `Bearer realm="${AUTH_REALM}"`,
    `resource_metadata="${resourceOrigin}${PROTECTED_RESOURCE_METADATA_PATH}"`,
  ];
  if (failure) {
    parts.push(`error="${failure.error}"`);
    parts.push(`error_description="${failure.description.replaceAll('"', "'")}"`);
  }
  return parts.join(", ");
}

/**
 * A 401 carrying the challenge. Returned both for a missing credential and for a rejected one; the
 * difference is the `error` parameter, which is what tells a client whether to start a fresh
 * authorization or to refresh what it already has.
 */
export function unauthorizedResponse(
    requestUrl: URL, failure?: { error: string; description: string }): Response {
  let body = {
    error: failure?.error ?? "unauthorized",
    error_description: failure?.description ??
        "This endpoint requires an Authorization: Bearer credential.",
  };
  return mcpResponse(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": buildAuthenticateChallenge(requestUrl.origin, failure),
    },
  });
}

/**
 * Resolves the caller of an `/mcp` request, or produces the response that refuses it.
 *
 * Never throws for an authentication failure -- an unauthenticated MCP request is an ordinary
 * outcome of the discovery handshake (the client is *expected* to probe unauthenticated first), so
 * it is a value, not an exception.
 */
export async function authenticateMcpRequest(
    req: Request, url: URL, deps: McpAuthDeps): Promise<McpAuthResult> {
  let credential = parseBearerCredential(req);
  if (credential === null) {
    return { ok: false, response: unauthorizedResponse(url) };
  }

  let validator = CREDENTIAL_VALIDATORS.find(candidate => candidate.matches(credential!));
  if (!validator) {
    return { ok: false, response: unauthorizedResponse(url, {
      error: "invalid_token",
      description: "Unrecognized credential format.",
    }) };
  }

  try {
    return { ok: true, principal: await validator.authenticate(credential, deps) };
  } catch (error) {
    // The underlying authenticate() distinguishes its failures with codes, but none of them are
    // safe to relay verbatim to an unauthenticated caller, and none change what the client should
    // do: obtain a fresh credential.
    return { ok: false, response: unauthorizedResponse(url, {
      error: "invalid_token",
      description: "The supplied credential is not valid for this deployment.",
    }) };
  }
}
