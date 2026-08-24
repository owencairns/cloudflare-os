// Storage for the authorization server: registered clients, pending authorization requests, and
// issued authorization codes.
//
// **Why a Durable Object, and why one of them.** All three of these are cross-request flow state
// with a single natural owner (the deployment), and all three must be strongly consistent -- an
// authorization code that could be redeemed twice because two edge locations disagreed would be the
// whole vulnerability. This follows the `PendingLogin` pattern next door, except that PendingLogin
// bridges one in-flight request and holds nothing durable, whereas registrations outlive the
// browser that made them, so this one actually stores.
//
// **What is deliberately NOT here: access tokens.** The token endpoint mints through
// `UserDurableObject.mintAgentCredential()`, so an OAuth-granted credential is an ordinary agent
// session in the user's own DO -- the same record the Settings page lists, the same record
// `authenticate()` checks, revocable by the same call. Storing tokens here would be a second,
// divergent copy of the thing that already exists.
//
// Everything in this DO is short-lived except client registrations. Expired requests and codes are
// swept opportunistically on each write; nothing schedules an alarm, because a stale row is
// unusable (every read re-checks `expiresAt`) and the volume is tiny.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { AgentScope } from "@gadgets/workshop-shared/api";
import {
  AUTHORIZATION_CODE_TTL_MS, AUTHORIZATION_REQUEST_TTL_MS, randomToken,
  type RegistrationRequest,
} from "./protocol.js";

/** A client registered through RFC 7591. Public clients only, so there is no secret to store. */
export type OAuthClientRecord = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** Scopes the client declared at registration. Advisory only; each request asks again. */
  scopes?: AgentScope[];
  createdAt: Date;
};

/**
 * An authorization request that has passed validation and is waiting for the user's decision. The
 * `requestId` is what travels in the approval page's URL, so it names a request without exposing
 * anything the client sent -- in particular the `state`, which the page never needs to see.
 */
export type PendingAuthorizationRecord = {
  requestId: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  /** The MCP `resource` parameter (RFC 8707), echoed back for the client's own binding checks. */
  resource?: string;
  requestedScopes: AgentScope[];
  createdAt: Date;
  expiresAt: Date;
};

/** An issued authorization code, bound to everything the token request must reproduce. */
export type AuthorizationCodeRecord = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Scopes the user actually approved, which may be narrower than what was requested. */
  scopes: AgentScope[];
  /** The user DO's name -- i.e. the account whose credential this code will mint. */
  username: string;
  /** The client name, which becomes the minted credential's label. */
  clientName: string;
  resource?: string;
  expiresAt: Date;
};

/** What {@link OAuthProvider.consumeCode} answers with, since errors do not cross a DO boundary. */
export type ConsumeCodeResult =
    | { ok: true; record: AuthorizationCodeRecord }
    | { ok: false; error: string; description: string };

function makeProviderStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      clients: collection<OAuthClientRecord>()({ primaryKey: "clientId" }),
      requests: collection<PendingAuthorizationRecord>()({ primaryKey: "requestId" }),
      codes: collection<AuthorizationCodeRecord>()({ primaryKey: "code" }),
    },
    singletons: {},
  });
}

/**
 * The deployment's authorization-server state. A singleton: reached as
 * `ctx.exports.OAuthProvider.getByName("")`, like `AdminSettings`.
 */
export class OAuthProvider extends DurableObject<Cloudflare.Env> {
  #storage = makeProviderStorage(this.ctx.storage);

  /** Drop requests and codes whose window has closed. Cheap; the working set is a handful of rows. */
  #sweep(now: number): void {
    // Materialized before deleting: `list()` is a live iterable over the collection being mutated.
    for (let request of Array.from(this.#storage.requests.list())) {
      if (request.expiresAt.valueOf() <= now) this.#storage.requests.delete(request.requestId);
    }
    for (let code of Array.from(this.#storage.codes.list())) {
      if (code.expiresAt.valueOf() <= now) this.#storage.codes.delete(code.code);
    }
  }

  // --- Dynamic client registration -----------------------------------------------------------

  /**
   * Register a client and return the record, including the freshly minted `client_id`. Registration
   * is unauthenticated (that is what "dynamic" means in RFC 7591) and confers nothing on its own: a
   * client id is only ever a name a user is later shown while approving.
   */
  async registerClient(request: RegistrationRequest): Promise<OAuthClientRecord> {
    let record: OAuthClientRecord = {
      clientId: randomToken("mpc_"),
      clientName: request.clientName,
      redirectUris: request.redirectUris,
      scopes: request.scopes,
      createdAt: new Date(),
    };
    this.#storage.clients.put(record);
    this.#sweep(Date.now());
    return record;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    return this.#storage.clients.get(clientId) ?? null;
  }

  // --- Authorization requests ----------------------------------------------------------------

  /**
   * Record a validated authorization request and return its id. Called by `/oauth/authorize` right
   * before it redirects the browser to the approval page.
   */
  async beginAuthorization(
      request: Omit<PendingAuthorizationRecord, "requestId" | "createdAt" | "expiresAt">)
      : Promise<string> {
    let now = Date.now();
    this.#sweep(now);
    let record: PendingAuthorizationRecord = {
      ...request,
      requestId: randomToken("mpr_"),
      createdAt: new Date(now),
      expiresAt: new Date(now + AUTHORIZATION_REQUEST_TTL_MS),
    };
    this.#storage.requests.put(record);
    return record.requestId;
  }

  /** Read a pending request without consuming it (the approval page's GET). */
  async getAuthorizationRequest(requestId: string): Promise<PendingAuthorizationRecord | null> {
    let record = this.#storage.requests.get(requestId);
    if (!record) return null;
    if (record.expiresAt.valueOf() <= Date.now()) {
      this.#storage.requests.delete(requestId);
      return null;
    }
    return record;
  }

  /**
   * Read a pending request *and* remove it, so a decision -- approve or deny -- can be made exactly
   * once. Returns null for an unknown or expired request, which the caller reports the same way.
   */
  async consumeAuthorizationRequest(requestId: string): Promise<PendingAuthorizationRecord | null> {
    let record = await this.getAuthorizationRequest(requestId);
    if (record) this.#storage.requests.delete(requestId);
    return record;
  }

  // --- Authorization codes -------------------------------------------------------------------

  /** Issue a one-time authorization code bound to the approval that produced it. */
  async issueCode(grant: Omit<AuthorizationCodeRecord, "code" | "expiresAt">): Promise<string> {
    let now = Date.now();
    this.#sweep(now);
    let record: AuthorizationCodeRecord = {
      ...grant,
      code: randomToken("mpa_"),
      expiresAt: new Date(now + AUTHORIZATION_CODE_TTL_MS),
    };
    this.#storage.codes.put(record);
    return record.code;
  }

  /**
   * Redeem a code, checking the bindings RFC 6749 §4.1.3 requires: the code exists, has not
   * expired, was issued to *this* client, and for *this* redirect URI. The code is deleted before
   * any of those are reported, so a failed attempt burns it -- a replayed or mis-addressed code is
   * spent, not retryable.
   *
   * PKCE is verified by the caller, which holds the `code_verifier`; this returns the challenge the
   * code was bound to.
   */
  async consumeCode(
      code: string, clientId: string, redirectUri: string | undefined): Promise<ConsumeCodeResult> {
    let record = this.#storage.codes.get(code);
    if (!record) {
      return { ok: false, error: "invalid_grant",
               description: "The authorization code is unknown, expired, or already used." };
    }
    // Single use, unconditionally: even a mismatched client burns the code, since reaching here
    // with someone else's code means the code has leaked.
    this.#storage.codes.delete(code);

    if (record.expiresAt.valueOf() <= Date.now()) {
      return { ok: false, error: "invalid_grant",
               description: "The authorization code is unknown, expired, or already used." };
    }
    if (record.clientId !== clientId) {
      return { ok: false, error: "invalid_grant",
               description: "This authorization code was issued to a different client." };
    }
    // RFC 6749 requires redirect_uri on the token request when it was present on the authorization
    // request, and it always is here (we resolve a default before issuing).
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      return { ok: false, error: "invalid_grant",
               description: "redirect_uri does not match the authorization request." };
    }
    return { ok: true, record };
  }
}
