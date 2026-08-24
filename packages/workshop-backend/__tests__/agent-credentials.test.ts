import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_CREDENTIAL_PREFIX, AGENT_SCOPES, FULL_SCOPES, getAuthErrorCode, AUTH_ERROR_CODES,
  hasScope, isAgentScope, isFullAuthority, type AgentScope, type SessionAuthInfo,
} from "@gadgets/workshop-shared/api";
import { formatAgentCredential, parseCredential } from "../src/auth/credentials.js";
import { UserDurableObject } from "../src/user.js";

// A stand-in for the `sessions` typed-storage collection, keyed by tokenId like the real one. The
// user DO is exercised through a prototype-grafted instance, matching user-verifier.test.ts and
// user-model-resolution.test.ts -- these tests are about the session logic, not DO plumbing.
function makeSessions(initial: any[] = []) {
  const map = new Map<string, any>(initial.map(r => [r.tokenId, r]));
  return {
    map,
    get: (tokenId: string) => map.get(tokenId),
    put: (record: any) => { map.set(record.tokenId, record); },
    delete: (tokenId: string) => map.delete(tokenId),
    list: () => map.values(),
  };
}

function makeUser(sessions: ReturnType<typeof makeSessions>): UserDurableObject {
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, { storage: { sessions } });
  return user;
}

// Recover the storage key for a secret the DO just handed back, the same way authenticate() does.
async function tokenIdOf(secret: string): Promise<string> {
  const bytes = Uint8Array.fromBase64(secret);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();
}

async function authErrorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return getAuthErrorCode(err);
  }
  return undefined;
}

describe("scope helpers", () => {
  it("treats a browser session as holding every scope", () => {
    const browser: SessionAuthInfo = { kind: "browser", scopes: FULL_SCOPES };
    for (const scope of AGENT_SCOPES) expect(hasScope(browser, scope)).toBe(true);
    expect(isFullAuthority(browser)).toBe(true);
  });

  it("does not treat a partially-scoped agent credential as full authority", () => {
    const agent: SessionAuthInfo = { kind: "agent", scopes: ["read", "build", "chat"] };
    expect(isFullAuthority(agent)).toBe(false);
    expect(hasScope(agent, "admin")).toBe(false);
    expect(hasScope(agent, "build")).toBe(true);
  });

  it("recognizes exactly the four known scopes", () => {
    for (const scope of AGENT_SCOPES) expect(isAgentScope(scope)).toBe(true);
    for (const bogus of ["write", "READ", "", null, 3]) expect(isAgentScope(bogus)).toBe(false);
  });
});

describe("credential wire format", () => {
  it("round-trips an agent credential through its prefix", () => {
    const wire = formatAgentCredential("alice", "c2VjcmV0");
    expect(wire).toBe(`${AGENT_CREDENTIAL_PREFIX}alice:c2VjcmV0`);
    expect(parseCredential(wire)).toEqual(
        { username: "alice", secret: "c2VjcmV0", prefixed: true });
  });

  it("parses an unprefixed browser token and reports it as unprefixed", () => {
    expect(parseCredential("alice:c2VjcmV0")).toEqual(
        { username: "alice", secret: "c2VjcmV0", prefixed: false });
  });

  it("rejects malformed credentials with the standard auth error", async () => {
    for (const bad of ["nocolon", "a:b:c", ":secret", "alice:", AGENT_CREDENTIAL_PREFIX + "alice"]) {
      expect(await authErrorCode(async () => parseCredential(bad)))
          .toBe(AUTH_ERROR_CODES.invalidSessionToken);
    }
  });
});

describe("UserDurableObject session records", () => {
  let sessions: ReturnType<typeof makeSessions>;
  let user: UserDurableObject;

  beforeEach(() => {
    sessions = makeSessions();
    user = makeUser(sessions);
  });

  it("authenticates a legacy record (no kind) as a full-authority browser session", async () => {
    // Exactly the shape written before agent credentials existed: tokenId + created, nothing else.
    const secret = new Uint8Array([1, 2, 3, 4]).toBase64();
    sessions.put({ tokenId: await tokenIdOf(secret), created: new Date("2026-01-01") });

    const info = await user.authenticate(secret);
    expect(info.kind).toBe("browser");
    expect(info.scopes.toSorted()).toEqual(AGENT_SCOPES.toSorted());
    expect(isFullAuthority(info)).toBe(true);
  });

  it("leaves a legacy record untouched on authentication", async () => {
    const secret = new Uint8Array([9, 9, 9, 9]).toBase64();
    const tokenId = await tokenIdOf(secret);
    const original = { tokenId, created: new Date("2026-01-01") };
    sessions.put(original);

    await user.authenticate(secret);
    // No lastUsed write-back for browser sessions: the field exists for agent connections.
    expect(sessions.get(tokenId)).toEqual(original);
  });

  it("mints an agent credential carrying exactly the granted scopes", async () => {
    const secret = await user.mintAgentCredential("Claude Desktop", ["read", "chat"]);

    const info = await user.authenticate(secret);
    expect(info.kind).toBe("agent");
    expect(info.label).toBe("Claude Desktop");
    expect(info.scopes.toSorted()).toEqual(["chat", "read"]);
    expect(isFullAuthority(info)).toBe(false);
  });

  it("stores only the hash of the minted credential", async () => {
    const secret = await user.mintAgentCredential("agent", ["read"]);
    const stored = [...sessions.map.values()];

    expect(stored).toHaveLength(1);
    expect(stored[0].tokenId).toBe(await tokenIdOf(secret));
    expect(JSON.stringify(stored[0])).not.toContain(secret);
  });

  it("rejects unknown scopes rather than silently dropping them", async () => {
    await expect(user.mintAgentCredential("agent", ["read", "superuser"]))
        .rejects.toThrow(/Unknown scope\(s\): superuser/);
    expect(sessions.map.size).toBe(0);
  });

  it("requires a label", async () => {
    await expect(user.mintAgentCredential("   ", ["read"])).rejects.toThrow(/label/);
  });

  it("dedupes a repeated scope so the stored grant matches what was approved", async () => {
    const secret = await user.mintAgentCredential("agent", ["read", "read", "build"]);
    const info = await user.authenticate(secret);
    expect(info.scopes).toEqual(["read", "build"]);
  });

  it("refuses an expired credential and deletes it, indistinguishably from an unknown one",
     async () => {
    const secret = await user.mintAgentCredential(
        "agent", ["read"], new Date(Date.now() - 1000));
    const tokenId = await tokenIdOf(secret);

    expect(await authErrorCode(() => user.authenticate(secret)))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
    expect(sessions.get(tokenId)).toBeUndefined();
  });

  it("accepts a credential whose expiry is still in the future", async () => {
    const secret = await user.mintAgentCredential(
        "agent", ["read"], new Date(Date.now() + 60_000));
    await expect(user.authenticate(secret)).resolves.toMatchObject({ kind: "agent" });
  });

  it("records lastUsed for an agent credential", async () => {
    const secret = await user.mintAgentCredential("agent", ["read"]);
    const tokenId = await tokenIdOf(secret);
    expect(sessions.get(tokenId).lastUsed).toBeUndefined();

    await user.authenticate(secret);
    expect(sessions.get(tokenId).lastUsed).toBeInstanceOf(Date);
  });

  it("does not rewrite lastUsed on every authentication", async () => {
    const secret = await user.mintAgentCredential("agent", ["read"]);
    const tokenId = await tokenIdOf(secret);

    await user.authenticate(secret);
    const first = sessions.get(tokenId).lastUsed;
    await user.authenticate(secret);
    expect(sessions.get(tokenId).lastUsed).toBe(first);
  });

  it("rejects a corrupt (non-base64) secret as an auth failure", async () => {
    expect(await authErrorCode(() => user.authenticate("not!base64!")))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
  });

  it("lists sessions without exposing token material, newest first", async () => {
    sessions.put({ tokenId: "legacy", created: new Date("2026-01-01") });
    await user.mintAgentCredential("agent", ["read", "build"]);

    const listed = await user.listSessions();
    expect(listed).toHaveLength(2);
    expect(listed[0].kind).toBe("agent");
    expect(listed[0].label).toBe("agent");
    expect(listed[0].scopes).toEqual(["read", "build"]);
    // The legacy record surfaces as the browser session it is.
    expect(listed[1]).toMatchObject({ tokenId: "legacy", kind: "browser", scopes: FULL_SCOPES });
  });

  it("revokes a credential so it stops authenticating", async () => {
    const secret = await user.mintAgentCredential("agent", ["read"]);
    const tokenId = await tokenIdOf(secret);

    expect(await user.revokeSession(tokenId)).toBe(true);
    expect(await authErrorCode(() => user.authenticate(secret)))
        .toBe(AUTH_ERROR_CODES.invalidSessionToken);
    // Revoking again is a no-op, not an error.
    expect(await user.revokeSession(tokenId)).toBe(false);
  });

  it("keeps other sessions alive when one is revoked", async () => {
    const keep = await user.mintAgentCredential("keep", ["read"]);
    const drop = await user.mintAgentCredential("drop", ["read"]);

    await user.revokeSession(await tokenIdOf(drop));
    await expect(user.authenticate(keep)).resolves.toMatchObject({ label: "keep" });
  });
});

// The scope model's whole point is that these predicates decide what happens at four capability
// seams. The seams themselves live in server.ts/overseer.ts and are covered by their own suites;
// what's asserted here is the decision each seam makes for a given scope set, so a change to the
// table below is a deliberate, visible one.
describe("scope gating decisions", () => {
  const agent = (...scopes: AgentScope[]): SessionAuthInfo => ({ kind: "agent", scopes });
  const browser: SessionAuthInfo = { kind: "browser", scopes: FULL_SCOPES };

  // getAdminApi() / amIAdmin()
  it("withholds the admin capability from any session lacking the admin scope", () => {
    expect(hasScope(agent("read", "build", "chat"), "admin")).toBe(false);
    expect(hasScope(agent("admin"), "admin")).toBe(true);
    expect(hasScope(browser, "admin")).toBe(true);
  });

  // openGadget()
  it("requires the read scope to open a workspace at all", () => {
    expect(hasScope(agent("build"), "read")).toBe(false);
    expect(hasScope(agent("read"), "read")).toBe(true);
  });

  // open() role cap: no "build" => the restricted "use" Overseer.
  it("caps the workspace capability at 'use' without the build scope", () => {
    const roleFor = (info: SessionAuthInfo) => hasScope(info, "build") ? "build" : "use";
    expect(roleFor(agent("read"))).toBe("use");
    expect(roleFor(agent("read", "chat"))).toBe("use");
    expect(roleFor(agent("read", "build"))).toBe("build");
    expect(roleFor(browser)).toBe("build");
  });

  // OverseerClientInterface chat entrypoints.
  it("denies the agent-driving entrypoints to a build-only credential", () => {
    expect(hasScope(agent("read", "build"), "chat")).toBe(false);
    expect(hasScope(agent("read", "build", "chat"), "chat")).toBe(true);
  });

  // Minting/revoking authority.
  it("never lets a narrowed credential mint or revoke authority", () => {
    expect(isFullAuthority(agent("read", "build", "chat"))).toBe(false);
    expect(isFullAuthority(agent(...AGENT_SCOPES))).toBe(true);
    expect(isFullAuthority(browser)).toBe(true);
  });
});
