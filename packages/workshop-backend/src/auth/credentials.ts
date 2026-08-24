// The wire format of a session credential, and the seam that turns one into a user + authority.
//
// Two kinds of credential authenticate against the same `sessions` collection in the user DO:
//
//   browser  `<username>:<base64-secret>`
//   agent    `mpk_<username>:<base64-secret>`
//
// The prefix carries no authority of its own -- the stored record decides what a credential may do
// -- but it lets a holder (and a log line, and a request handler) tell the two apart without a
// storage lookup, and it lets `PublicApi.authenticate()` reject a credential whose advertised kind
// disagrees with the record it resolves to.

import {
  AGENT_CREDENTIAL_PREFIX, AUTH_ERROR_CODES, createAuthError,
} from "@gadgets/workshop-shared/api";

/** A credential string split into its parts. */
export type ParsedCredential = {
  /** The username naming the user DO. */
  username: string;
  /** The base64 secret, as `UserDurableObject.authenticate()` takes it. */
  secret: string;
  /** Whether the string carried `AGENT_CREDENTIAL_PREFIX`, i.e. claims to be an agent credential. */
  prefixed: boolean;
};

/**
 * Split a credential into username, secret and advertised kind. Throws the standard auth error for
 * anything malformed, so a garbled credential fails identically to a wrong one and reveals nothing
 * about which part was wrong.
 */
export function parseCredential(token: string): ParsedCredential {
  let prefixed = token.startsWith(AGENT_CREDENTIAL_PREFIX);
  let body = prefixed ? token.slice(AGENT_CREDENTIAL_PREFIX.length) : token;

  let split = body.split(":");
  if (split.length !== 2 || !split[0] || !split[1]) {
    throw createAuthError(AUTH_ERROR_CODES.invalidSessionToken);
  }

  return { username: split[0], secret: split[1], prefixed };
}

/**
 * Compose the wire form of an agent credential from the username and the secret
 * `UserDurableObject.mintAgentCredential()` returned. The OAuth authorization endpoint calls this
 * to build the access credential it hands the agent; it is the only place the full string exists.
 */
export function formatAgentCredential(username: string, secret: string): string {
  return `${AGENT_CREDENTIAL_PREFIX}${username}:${secret}`;
}
