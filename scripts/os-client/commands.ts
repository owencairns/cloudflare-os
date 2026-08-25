// Command implementations for the os-client CLI. Each command returns a plain JSON-serializable
// value; index.ts prints it.

import { readFileSync, writeFileSync } from "node:fs";
import { RpcStub, RpcTarget } from "capnweb";
import type {
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import { connect, connectAuthenticated, disposeQuietly, hashPassword, newClientId } from "./client.ts";

// ---------------------------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------------------------

export async function login(username: string, password: string): Promise<{ username: string; token: string; osToken: string }> {
  const pub = connect();
  try {
    const passwordHash = await hashPassword(username, password);
    const token = await pub.login(username, passwordHash);
    if (!token) {
      throw new Error(`Login failed for '${username}' (bad username/password, or login is disabled).`);
    }
    // The server's token is already the full "username:base64" string this CLI uses as OS_TOKEN.
    return { username, token, osToken: token };
  } finally {
    disposeQuietly(pub);
  }
}

export async function whoami(): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const [profile, isAdmin] = await Promise.all([auth.whoami(), auth.amIAdmin()]);
    return { ...profile, amIAdmin: isAdmin };
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------------------------

export async function wsList(): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    return await auth.listGadgets();
  } finally {
    disposeQuietly(pub);
  }
}

export async function wsCreate(title: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.newGadget();
    try {
      await overseer.setTitle(title);
      const metadata = await overseer.getMetadata();
      return metadata;
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function wsShow(wsId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const [metadata, workpieces, chats] = await Promise.all([
        overseer.getMetadata(),
        listWorkpieces(overseer),
        overseer.listChats(),
      ]);
      return { metadata, workpieces, chats };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

/** Permanently delete one workspace after the CLI has required an exact-id confirmation. */
export async function wsDelete(wsId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const metadata = await overseer.getMetadata();
      await overseer.deleteSelf();
      return { deleted: true, workspaceId: wsId, title: metadata.title };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

/** Collects the workpiece roster via the only enumeration path: subscribe, gather entry()
 *  deliveries until ready(), then dispose. */
async function listWorkpieces(overseer: RpcStub<Overseer>): Promise<WorkpieceSummary[]> {
  const entries: WorkpieceSummary[] = [];
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  class Subscriber extends RpcTarget implements WorkpiecesSubscriber {
    entry(summary: WorkpieceSummary): void {
      entries.push(summary);
    }
    removed(_id: WorkpieceId): void {
      // Not relevant for a one-shot listing.
    }
    ready(): void {
      resolveReady();
    }
  }

  const subscriber = new RpcStub(new Subscriber());
  const subscription = await overseer.subscribeToWorkpieces(subscriber);
  try {
    await readyPromise;
    return entries;
  } finally {
    disposeQuietly(subscription);
    disposeQuietly(subscriber);
  }
}

// ---------------------------------------------------------------------------------------------
// gadgets / code
// ---------------------------------------------------------------------------------------------

export async function gadgetCreate(wsId: string, title: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const gadget = await overseer.createGadget(title);
      try {
        const [id, gadgetTitle] = await Promise.all([gadget.getId(), gadget.getTitle()]);
        return { wsId, gadgetId: id, title: gadgetTitle };
      } finally {
        disposeQuietly(gadget);
      }
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

/** Remove a workspace-owned blueprint before retiring its source workspace. */
export async function blueprintDelete(wsId: string, blueprintId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      await overseer.deleteBlueprint(blueprintId);
      return { deleted: true, workspaceId: wsId, blueprintId };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function codeRead(wsId: string, gadgetId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const gid = Number(gadgetId);
      const workpieces = await listWorkpieces(overseer);
      const summary = workpieces.find((w) => w.id === gid);
      if (!summary) throw new Error(`No gadget ${gadgetId} in workspace ${wsId}.`);
      if (!summary.commitId) {
        return { gadgetId: gid, files: [], note: "gadget has no head commit yet (still pending in a chat)" };
      }
      const { files } = await overseer.getCodeAtCommit(summary.commitId);
      return { gadgetId: gid, commitId: summary.commitId, files };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1500;

export async function codeWrite(
  wsId: string,
  gadgetId: string,
  chatId: string,
  path: string,
  filePath: string,
): Promise<unknown> {
  const content = readFileSync(filePath, "utf8");
  const gid = Number(gadgetId);
  const cid = Number(chatId);
  const clientId = newClientId();

  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // Re-fetch chat state and pin status fresh on every attempt: retries after a "throws
        // retryably while an agent turn is active" error need the *current* generation/revision.
        const chats = await overseer.listChats();
        const chat = chats.find((c) => c.id === cid);
        if (!chat) throw new Error(`No chat ${chatId} in workspace ${wsId}.`);
        const codeBase = chat.codeBase ?? { pins: [], generation: 0, revision: 0 };
        const alreadyPinned = codeBase.pins.some((p) => p.gadgetId === gid);

        let pins: { gadgetId: WorkpieceId; baseCommit: string }[] | undefined;
        if (!alreadyPinned) {
          const workpieces = await listWorkpieces(overseer);
          const summary = workpieces.find((w) => w.id === gid);
          if (!summary) throw new Error(`No gadget ${gadgetId} in workspace ${wsId}.`);
          if (summary.commitId) {
            pins = [{ gadgetId: gid, baseCommit: summary.commitId }];
          }
          // If the gadget is still pending in this chat (no commitId), it needs no pin
          // declaration -- its changes build content up from nothing.
        }

        try {
          const result = await overseer.submitCodeChange(cid, {
            generation: codeBase.generation,
            revision: codeBase.revision,
            clientId,
            seq: 1,
            pins,
            change: { [gid]: [[path, { set: content }]] },
          });
          return { wsId, gadgetId: gid, chatId: cid, path, bytesWritten: content.length, ...result };
        } catch (err) {
          lastError = err;
          const message = err instanceof Error ? err.message : String(err);
          const retryable = /retry|agent turn|active/i.test(message);
          if (!retryable || attempt === MAX_RETRIES) throw err;
          console.error(
            `[os-client] submitCodeChange rejected (attempt ${attempt}/${MAX_RETRIES}, likely an ` +
              `active agent turn): ${message} -- retrying in ${RETRY_DELAY_MS}ms`,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      throw lastError;
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function codeMerge(wsId: string, chatId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const result = await overseer.mergeChanges(Number(chatId));
      return result;
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------------------------

export async function chatNew(wsId: string, message: string, modelId: string | null): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const chatId = await overseer.newChat(message, modelId);
      return { wsId, chatId };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function chatSend(wsId: string, chatId: string, message: string, modelId: string | null): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      await overseer.sendChatMessage(Number(chatId), message, modelId);
      return { wsId, chatId: Number(chatId), sent: true };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function chatRead(wsId: string, chatId: string): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      return await overseer.getChatHistory(Number(chatId));
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// blueprints / outputs
// ---------------------------------------------------------------------------------------------

export async function blueprintPublish(
  wsId: string,
  gadgetId: string,
  title?: string,
  description?: string,
): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const gadget = await overseer.getGadget(Number(gadgetId));
      try {
        return await gadget.createBlueprint(title, description);
      } finally {
        disposeQuietly(gadget);
      }
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function blueprintInstall(blueprintId: string): Promise<unknown> {
  // newGadgetFromBlueprint lives on AuthenticatedApi (api.ts ~line 658): it creates a brand new
  // workspace seeded from the blueprint, not a gadget within an existing one.
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.newGadgetFromBlueprint(blueprintId, {});
    try {
      return await overseer.getMetadata();
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

export async function outputsList(): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    return await auth.listOutputs();
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------------------------

export async function adminSignups(enabled: boolean): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const admin = await auth.getAdminApi();
    if (!admin) throw new Error("Current user is not an admin (getAdminApi() returned null).");
    try {
      await admin.setSignupsEnabled(enabled);
      const settings = await admin.getSettings();
      return { signupsEnabled: enabled, settings };
    } finally {
      disposeQuietly(admin);
    }
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// gadget RPC — the agent API for first-party gadgets
// ---------------------------------------------------------------------------------------------

/**
 * Calls a method on a gadget's own RPC surface: `openGadget(ws)` → `getGadget(0)` →
 * `connectToGadget()` → `stub[method](...args)`.
 *
 * This is how agents drive the first-party gadgets from a terminal (the /mcp endpoint only
 * exposes platform-level tools — workspaces, gadgets, files — not these surfaces).
 */
export async function gadgetRpc(
  wsId: string,
  method: string,
  args: unknown[],
  gadgetIndex = 0,
): Promise<unknown> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const gadget = await overseer.getGadget(gadgetIndex);
      try {
        const api = (await gadget.connectToGadget()) as RpcStub<Record<string, (...a: unknown[]) => Promise<unknown>>>;
        try {
          // NB: call through the proxy directly. `fn.apply(...)` would send an "apply"
          // call over the wire (Cap'n Web stubs are proxies), not invoke the method.
          const target = api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
          return await target[method](...args);
        } finally {
          disposeQuietly(api as RpcStub<unknown>);
        }
      } finally {
        disposeQuietly(gadget);
      }
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// Context — the ambient company-knowledge surface
// ---------------------------------------------------------------------------------------------

async function withContextApi<T>(
  fn: (api: RpcStub<Record<string, (...args: unknown[]) => Promise<unknown>>>) => Promise<T>,
): Promise<T> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const frame = await auth.getGatekeeperApp("context");
    if (!frame) throw new Error("The Context management app is not available.");
    const api = frame.ui as RpcStub<Record<string, (...args: unknown[]) => Promise<unknown>>>;
    try {
      return await fn(api);
    } finally {
      disposeQuietly(api as RpcStub<unknown>);
    }
  } finally {
    disposeQuietly(pub);
  }
}

/** Call the trusted management capability exposed by the current user's Context account. */
export async function contextRpc(method: string, args: unknown[]): Promise<unknown> {
  return withContextApi(async api => {
    const target = api as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>;
    return target[method](...args);
  });
}

/** List Context collections, or documents within one collection. */
export async function contextList(collectionId?: string, prefix?: string): Promise<unknown> {
  return collectionId
    ? contextRpc("listContextDocuments", [collectionId, prefix])
    : contextRpc("listEnabledContextCollections", []);
}

/** Full-text search across the current user's visible Context collections. */
export async function contextSearch(query: string, limit: number): Promise<unknown> {
  return contextRpc("searchContextLibrary", [query, { limit }]);
}

/** Read one Context document by collection id and path. */
export async function contextRead(collectionId: string, path: string): Promise<unknown> {
  return contextRpc("getContextDocument", [collectionId, path]);
}

/** Write one Markdown file into an owned Context collection. */
export async function contextWrite(
  collectionId: string,
  path: string,
  file: string,
  description: string,
): Promise<unknown> {
  await contextRpc("putContextDocument", [
    collectionId,
    path,
    { description, body: readFileSync(file, "utf8"), contentType: "text/markdown" },
  ]);
  return { collectionId, path, file };
}

/** Export Context to a JSON file without printing document bodies to the terminal. */
export async function contextExport(file: string): Promise<unknown> {
  let snapshot = await contextRpc("exportContextLibrary", []);
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + "\n");
  let collections = (snapshot as { collections?: Array<{documents?: unknown[]}> }).collections ?? [];
  return {
    file,
    collections: collections.length,
    documents: collections.reduce((count, collection) =>
      count + (collection.documents?.length ?? 0), 0),
  };
}

/** Import a Context JSON backup through the same management capability as the web UI. */
export async function contextImport(
  file: string,
  mode: "merge" | "replace",
): Promise<unknown> {
  let snapshot = JSON.parse(readFileSync(file, "utf8"));
  return contextRpc("importContextLibrary", [snapshot, { mode }]);
}
