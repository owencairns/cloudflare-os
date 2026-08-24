// Thin Cap'n Web client for a MyoPlan OS instance (Cloudflare OS fork). Wraps the WebSocket RPC
// session, dev/prod auth, and the argon2id password-hash scheme the server expects.

import { RpcStub, newWebSocketRpcSession } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";

// Duplicated (not imported) from packages/workshop-shared/src/api.ts on purpose: that module has
// a *value* import of "./gatekeeper.js" (a .ts file, no compiled .js on disk), which Vite's
// bundler resolver papers over but plain `node` cannot -- so any runtime (non `import type`) import
// of api.ts fails under this CLI's "run .ts directly with node" setup. Every other symbol we need
// from that module is a type, erased at compile time via `import type`; this constant is the one
// exception, so we inline its value instead. Keep it in sync with SERVICE_SALT in api.ts.
const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21,
]);

export function getOsUrl(): string {
  return (process.env.OS_URL?.trim() || "http://localhost:8787").replace(/\/+$/, "");
}

/**
 * OS_TOKEN is `username:base64token` -- which, as it turns out, is exactly the literal string
 * PublicApi.login() returns. The whole thing is the session token `authenticate()` expects; the
 * "username:" prefix is not a wrapper this CLI adds, it's baked into the server's token format.
 * We still split it to display the username, but `token` (sent to authenticate()) is the raw
 * OS_TOKEN value unchanged.
 */
export function parseOsToken(raw: string): { username: string; token: string } {
  const idx = raw.indexOf(":");
  if (idx === -1) {
    throw new Error(
      "OS_TOKEN must be in the form 'username:token' (as printed by `os-client login`).",
    );
  }
  return { username: raw.slice(0, idx), token: raw };
}

export function requireOsToken(): { username: string; token: string } {
  const raw = process.env.OS_TOKEN;
  if (!raw) {
    throw new Error(
      "OS_TOKEN is not set. Run `pnpm os-client login <username>` first, or export OS_TOKEN " +
        "(or set it in ./.os-client.env).",
    );
  }
  return parseOsToken(raw);
}

function wsUrlFor(osUrl: string): string {
  const u = new URL(osUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/api";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Opens a fresh WebSocket RPC session against OS_URL. Caller owns disposal. */
export function connect(osUrl: string = getOsUrl()): RpcStub<PublicApi> {
  return newWebSocketRpcSession<PublicApi>(wsUrlFor(osUrl));
}

/** Connects and authenticates using OS_TOKEN, returning both stubs so the caller can dispose
 *  the outer one when done (disposing `pub` disposes the whole session). */
export async function connectAuthenticated(
  osUrl: string = getOsUrl(),
): Promise<{ pub: RpcStub<PublicApi>; auth: RpcStub<AuthenticatedApi> }> {
  const { token } = requireOsToken();
  const pub = connect(osUrl);
  try {
    const auth = await pub.authenticate(token);
    return { pub, auth };
  } catch (err) {
    disposeQuietly(pub);
    throw err;
  }
}

export function disposeQuietly(stub: RpcStub<unknown>): void {
  try {
    (stub as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
  } catch {
    /* already broken */
  }
}

/**
 * Derive the argon2id password hash the server expects, replicating
 * packages/workshop-frontend/src/passwordHash.ts:
 *
 *   argon2id({ password, salt: SERVICE_SALT + utf8(username), parallelism: 1, iterations: 3,
 *              memorySize: 64MiB, hashLength: 32 })
 */
export async function hashPassword(username: string, password: string): Promise<Uint8Array> {
  const { argon2id } = await import("hash-wasm");

  const usernameBuf = new TextEncoder().encode(username);
  const salt = new Uint8Array(SERVICE_SALT.length + usernameBuf.length);
  salt.set(SERVICE_SALT);
  salt.set(usernameBuf, SERVICE_SALT.length);

  const hash = await argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64 MiB in KiB
    hashLength: 32,
    outputType: "binary",
  });

  return hash;
}

/** A fresh random-ish client session id for CodeChangeSubmission.clientId. */
export function newClientId(): string {
  return crypto.randomUUID();
}
