// The v1 MCP tool table.
//
// Every tool here dispatches through the *same* capability objects the web UI uses --
// `AuthenticatedApi` -> `Overseer` -> `GadgetClient` (see workshop-shared/src/api.ts). There is no
// parallel API surface and no direct Durable Object access: if the UI can't do it, neither can a
// tool, and any authorization the API enforces for a browser is enforced here unchanged. That is
// the whole design constraint, and it is worth keeping: the alternative -- a second, MCP-shaped
// backend -- would be a second place for permission checks to drift.
//
// What is deliberately *not* here in v1: anything administrative (admin settings, featured
// blueprints), the action approval queue, and collaborator/share-link management. Those are refused
// unconditionally by not existing, because they are exactly the operations where an unscoped
// credential would be most dangerous, and scopes don't exist yet.

import {
  defineTool,
  jsonResult,
  textResult,
  ToolError,
  type ToolDefinition,
} from "@gadgets/mcp-server/tool";
import type {
  AiChatMessage,
  AiChatMetadata,
  AuthenticatedApi,
  BlueprintBindingAssignment,
  CodeChangeSubmission,
  GadgetClient,
  Overseer,
  WorkpieceId,
  WorkpieceSummary,
} from "@gadgets/workshop-shared/api";
import type { FileChange } from "@gadgets/workshop-shared/code-change";
import { RpcStub, RpcTarget } from "capnweb";
import { AGENT_RUNNING_ERROR_MESSAGE } from "../overseer.js";
import type { McpPrincipal } from "./auth.js";

/** Per-request context handed to every tool handler. */
export type McpToolContext = {
  principal: McpPrincipal;
  /** Shorthand for `principal.api`; the root of every call a tool makes. */
  api: AuthenticatedApi;
};

export type McpTool = ToolDefinition<McpToolContext>;

// =======================================================================================
// Scope enforcement seam

/**
 * ==> THE SCOPE SEAM <== The single place tool authorization is decided. `McpServer` calls this for
 * every `tools/call` (before the handler runs) and for every entry of `tools/list`.
 *
 * Today it lets everything through, because every credential this deployment accepts is unscoped
 * (`McpPrincipal.scopes === null` -- see mcp/auth.ts). When OAuth-issued credentials start carrying
 * the scopes a user approved, the `scopes !== null` branch below is where they get checked, keyed
 * on exactly what `authenticate()` returns; declaring a requirement on a tool is then a matter of
 * setting `scopes: [...]` in its definition.
 *
 * Returning a string refuses the call with that reason; `undefined` allows it.
 */
export function authorizeTool(tool: McpTool, ctx: McpToolContext): string | undefined {
  let granted = ctx.principal.scopes;
  if (granted === null) return undefined;  // Unscoped credential: full authority.

  let required = tool.scopes ?? [];
  let missing = required.filter(scope => !granted.includes(scope));
  if (missing.length === 0) return undefined;
  return `This credential is missing the scope${missing.length > 1 ? "s" : ""} ` +
      `${missing.join(", ")} required by "${tool.name}".`;
}

// =======================================================================================
// Plumbing

/**
 * Stubs handed out by the API hold a Durable Object connection; dropping one without disposing
 * leaks it for the life of the request. Disposal itself must never mask the real error, hence the
 * swallow.
 */
function disposeQuietly(stub: unknown): void {
  try {
    (stub as { [Symbol.dispose]?: () => void })?.[Symbol.dispose]?.();
  } catch {
    // Already disposed, or the session is gone. Either way there is nothing to do.
  }
}

/** Runs `body` with an open workspace, disposing the stub afterwards either way. */
async function withWorkspace<T>(
    ctx: McpToolContext, workspaceId: string,
    body: (overseer: Overseer) => Promise<T>): Promise<T> {
  let overseer: Overseer;
  try {
    overseer = await ctx.api.openGadget(workspaceId) as unknown as Overseer;
  } catch (error) {
    // openGadget's failures carry OPEN_GADGET_ERROR_CODES and are written for a user; relay them
    // as tool errors so the calling model sees "workspace not found" rather than a protocol fault.
    throw new ToolError(
        `Could not open workspace ${workspaceId}: ` +
        (error instanceof Error ? error.message : String(error)));
  }
  try {
    return await body(overseer);
  } finally {
    disposeQuietly(overseer);
  }
}

/**
 * Collects a workspace's workpieces.
 *
 * There is no `listWorkpieces()` -- the only way to enumerate them is `subscribeToWorkpieces`,
 * which pushes one `entry()` per existing workpiece and then `ready()`. So this subscribes, waits
 * for `ready()`, and immediately disposes: a one-shot read expressed through a streaming API. If a
 * list method is ever added, this is the only caller that has to change.
 */
async function listWorkpieces(overseer: Overseer): Promise<WorkpieceSummary[]> {
  let entries = new Map<WorkpieceId, WorkpieceSummary>();
  let ready: () => void;
  let readyPromise = new Promise<void>(resolve => { ready = resolve; });

  class Collector extends RpcTarget {
    entry(summary: WorkpieceSummary): void { entries.set(summary.id, summary); }
    removed(id: WorkpieceId): void { entries.delete(id); }
    ready(): void { ready(); }
  }

  // The subscriber must arrive as a Cap'n Web *stub*, not a bare object: the Overseer's RPC
  // interface is guarded by capnweb-validate, which rejects a plain object (or a native
  // `cloudflare:workers` RpcTarget) for a stub parameter. Wrapping a capnweb RpcTarget in
  // `new RpcStub(...)` is what an in-process caller hands over.
  //
  // The cast is Cap'n Web's recursive stub types failing to see that a stub *over* a subscriber is
  // a subscriber stub; the value handed over is a real `RpcStub`, which is what the runtime
  // validator checks for.
  let subscription = await overseer.subscribeToWorkpieces(
      new RpcStub(new Collector()) as unknown as
          Parameters<Overseer["subscribeToWorkpieces"]>[0]);
  try {
    // A workspace that can't answer would otherwise hang the MCP request until the platform's own
    // limit; failing at 30s gives the caller a usable error instead.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
          () => reject(new ToolError("Timed out listing the workspace's gadgets.")), 30_000);
    });
    try {
      await Promise.race([readyPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    disposeQuietly(subscription);
  }

  return [...entries.values()].toSorted((a, b) => a.id - b.id);
}

/** Finds one gadget workpiece by id, with an error that names what does exist. */
function requireGadget(workpieces: WorkpieceSummary[], gadgetId: WorkpieceId): WorkpieceSummary {
  let found = workpieces.find(piece => piece.id === gadgetId);
  if (!found) {
    let available = workpieces.map(piece => `${piece.id} (${piece.title})`).join(", ");
    throw new ToolError(
        `No gadget ${gadgetId} in this workspace.` +
        (available ? ` Available: ${available}.` : " The workspace has no gadgets yet."));
  }
  return found;
}

async function requireChat(overseer: Overseer, chatId: number): Promise<AiChatMetadata> {
  let chats = await overseer.listChats();
  let chat = chats.find(candidate => candidate.id === chatId);
  if (!chat) {
    let available = chats.map(candidate => `${candidate.id} (${candidate.title})`).join(", ");
    throw new ToolError(
        `No chat ${chatId} in this workspace.` +
        (available ? ` Available: ${available}.` : " The workspace has no chats yet."));
  }
  return chat;
}

/** Trims workspace metadata to what a caller can act on. */
function workspaceSummary(metadata: {
  id: string; title: string; pinned?: boolean; totalCost?: number;
  owner?: { name: string }; role?: string; defaultGadgetId?: WorkpieceId;
}, timestamps?: { created: Date; lastActive: Date }): Record<string, unknown> {
  return {
    id: metadata.id,
    title: metadata.title,
    ...(metadata.defaultGadgetId === undefined ? {} : { defaultGadgetId: metadata.defaultGadgetId }),
    ...(metadata.pinned ? { pinned: true } : {}),
    ...(metadata.owner ? { sharedBy: metadata.owner.name, role: metadata.role ?? "build" } : {}),
    ...(metadata.totalCost === undefined ? {} : { totalCost: metadata.totalCost }),
    ...(timestamps ? { created: timestamps.created, lastActive: timestamps.lastActive } : {}),
  };
}

/** One chat message rendered as plain text -- what a model reading a transcript actually needs. */
function flattenChatMessage(message: AiChatMessage): Record<string, unknown> {
  let base = {
    sequence: message.sequence,
    timestamp: message.timestamp,
    author: message.author.name,
    authorType: message.author.type,
  };

  if (message.type === "message") {
    let parts: string[] = [];
    if (message.reasoning) parts.push(`[reasoning] ${message.reasoning}`);
    if (message.message) parts.push(message.message);
    for (let call of message.toolCalls ?? []) {
      // Tool inputs can be whole file contents; a transcript read is not the place to replay them.
      parts.push(call.error
          ? `[tool ${call.toolName} failed: ${call.error}]`
          : `[tool ${call.toolName}]`);
    }
    return { ...base, type: "message", text: parts.join("\n\n") };
  }

  if (message.type === "slashCommand") {
    let { id, args } = message.request;
    let name = id.builtin ? id.commandId : `${id.commandId} (gatekeeper ${id.gatekeeperId})`;
    return { ...base, type: "slashCommand", text: `/${name}${args ? ` ${args}` : ""}` };
  }

  if (message.type === "changes") {
    let gadgets = message.change ? Object.keys(message.change) : [];
    let notes: string[] = [];
    if (gadgets.length > 0) notes.push(`edited gadget(s) ${gadgets.join(", ")}`);
    if (message.createdGadgets?.length) {
      notes.push(`created gadget(s) ${message.createdGadgets.map(g => g.gadgetId).join(", ")}`);
    }
    if (message.mainlineMerge) {
      let { conflictPaths } = message.mainlineMerge;
      notes.push(conflictPaths.length
          ? `merged from mainline with conflicts in ${conflictPaths.join(", ")}`
          : "merged from mainline");
    }
    return { ...base, type: "changes", text: `[changes: ${notes.join("; ") || "no code edits"}]` };
  }

  if (message.type === "merge") {
    // The accept: everything proposed through `mergeThrough` was committed.
    return { ...base, type: "merge",
             text: `[accepted changes through message ${message.mergeThrough}]` };
  }

  if (message.type === "revert") {
    return { ...base, type: "revert",
             text: `[reverted changes from message ${message.revertFrom}]` };
  }

  if (message.type === "action") {
    let state = message.actionLog?.state;
    return { ...base, type: "action",
             text: `[action ${message.actionId}${state ? `: ${state}` : ""}]` };
  }

  return { ...base, type: (message as { type: string }).type, text: "" };
}

/** True when the error is the workspace telling us an agent turn holds the chat's change stream. */
function isAgentBusy(error: unknown): boolean {
  return error instanceof Error && error.message.includes(AGENT_RUNNING_ERROR_MESSAGE);
}

// =======================================================================================
// Tools

const workspaceIdParam = {
  type: "string",
  description: "Workspace id, as returned by list_workspaces or create_workspace.",
} as const;

export const MCP_TOOLS: readonly McpTool[] = [

  defineTool<McpToolContext>({
    name: "list_workspaces",
    title: "List workspaces",
    description:
        "List every workspace the authenticated user can open, newest activity first. " +
        "A workspace is the top-level container: it holds gadgets (apps), chats, and outputs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scopes: ["workspaces:read"],
    handler: async (_args, ctx) => {
      let gadgets = await ctx.api.listGadgets();
      let sorted = gadgets.toSorted(
          (a, b) => b.lastActive.getTime() - a.lastActive.getTime());
      return jsonResult({
        workspaces: sorted.map(entry => workspaceSummary(entry, entry)),
      });
    },
  }),

  defineTool<McpToolContext>({
    name: "create_workspace",
    title: "Create workspace",
    description:
        "Create a new, empty workspace with the given title. Returns its id. " +
        "Note that a brand-new workspace is provisional until something happens in it (a chat " +
        "message or an accepted code change), and provisional workspaces are cleaned up " +
        "automatically and do not appear in list_workspaces.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Title for the new workspace." } },
      required: ["title"],
      additionalProperties: false,
    },
    scopes: ["workspaces:write"],
    handler: async (args, ctx) => {
      let overseer = await ctx.api.newGadget() as unknown as Overseer;
      try {
        await overseer.setTitle(args.title as string);
        let metadata = await overseer.getMetadata();
        return jsonResult({ workspace: workspaceSummary(metadata) });
      } finally {
        disposeQuietly(overseer);
      }
    },
  }),

  defineTool<McpToolContext>({
    name: "get_workspace",
    title: "Get workspace",
    description:
        "Read one workspace in detail: its metadata, its gadgets (each with the head commit its " +
        "committed code lives at), and its chats.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: workspaceIdParam },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    scopes: ["workspaces:read"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      // Metadata and chats are independent reads; the workpiece subscription is not, since it must
      // run to ready() before the others' results are useful to report together.
      let [metadata, workpieces, chats] = await Promise.all([
        overseer.getMetadata(),
        listWorkpieces(overseer),
        overseer.listChats(),
      ]);
      return jsonResult({
        workspace: workspaceSummary(metadata),
        gadgets: workpieces.map(piece => ({
          id: piece.id,
          title: piece.title,
          commitId: piece.commitId,
          // A gadget with a chatId is still provisional to that chat: it exists only until the
          // chat's changes are accepted or reverted.
          ...(piece.chatId === undefined ? {} : { pendingInChat: piece.chatId }),
          ...(piece.output === undefined ? {} : { format: piece.output }),
        })),
        chats: chats.map(chat => ({
          id: chat.id,
          title: chat.title,
          started: chat.started,
          lastActive: chat.lastActive,
          hasProposedChanges: chat.hasProposedChanges ?? false,
          agentRunning: chat.activeAgent !== undefined,
        })),
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "delete_workspace",
    title: "Delete workspace",
    description:
        "Permanently delete a workspace and everything in it: gadgets, chats, and history. " +
        "This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: workspaceIdParam },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    scopes: ["workspaces:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      await overseer.deleteSelf();
      return textResult(`Deleted workspace ${args.workspaceId}.`);
    }),
  }),

  defineTool<McpToolContext>({
    name: "create_gadget",
    title: "Create gadget",
    description:
        "Create a new gadget (an app) inside a workspace. The gadget starts with no files and no " +
        "bindings, and is created permanently -- its head is an empty initial commit, which is " +
        "what a later write_file pins against.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        title: { type: "string", description: "Title for the new gadget." },
        bindingName: {
          type: "string",
          description:
              "Name the gadget is bound under within the workspace. Must be unique in the " +
              "workspace. Omit to let the server derive one from the title.",
        },
      },
      required: ["workspaceId", "title"],
      additionalProperties: false,
    },
    scopes: ["workspaces:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      // No chatId: the gadget is permanent immediately rather than provisional to a chat.
      let gadget = await overseer.createGadget(
          args.title as string, undefined, args.bindingName as string | undefined,
      ) as unknown as GadgetClient;
      try {
        let id = await gadget.getId();
        return jsonResult({ gadget: { id, title: args.title } });
      } finally {
        disposeQuietly(gadget);
      }
    }),
  }),

  defineTool<McpToolContext>({
    name: "read_files",
    title: "Read gadget files",
    description:
        "Read every file of a gadget's committed code, at its current head commit. " +
        "This is mainline code: uncommitted edits proposed in a chat are not included until " +
        "accept_changes lands them.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        gadgetId: { type: "integer", description: "Gadget id, from get_workspace." },
      },
      required: ["workspaceId", "gadgetId"],
      additionalProperties: false,
    },
    scopes: ["code:read"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let gadgetId = args.gadgetId as WorkpieceId;
      let gadget = requireGadget(await listWorkpieces(overseer), gadgetId);
      if (gadget.commitId === undefined) {
        throw new ToolError(
            `Gadget ${gadgetId} has no committed code yet: it is still pending in chat ` +
            `${gadget.chatId}. Accept that chat's changes first.`);
      }
      let { files } = await overseer.getCodeAtCommit(gadget.commitId);
      return jsonResult({
        gadgetId,
        title: gadget.title,
        commitId: gadget.commitId,
        files: files
            .map(([path, content]) => ({ path, content }))
            .toSorted((a, b) => a.path.localeCompare(b.path)),
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "write_file",
    title: "Write gadget file",
    description:
        "Write a file's entire contents into a chat's proposed changes. The write is NOT " +
        "committed: it joins the chat's uncommitted change stream, exactly like an edit typed in " +
        "the UI, and becomes mainline code only when accept_changes is called for that chat. " +
        "Fails while an agent turn is running in the chat -- wait for it to finish and retry.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        gadgetId: { type: "integer", description: "Gadget id, from get_workspace." },
        chatId: {
          type: "integer",
          description: "Chat whose proposed changes this write joins, from list_chats.",
        },
        path: { type: "string", description: "File path within the gadget, e.g. \"src/index.ts\"." },
        content: { type: "string", description: "The entire new contents of the file." },
      },
      required: ["workspaceId", "gadgetId", "chatId", "path", "content"],
      additionalProperties: false,
    },
    scopes: ["code:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let gadgetId = args.gadgetId as WorkpieceId;
      let chatId = args.chatId as number;

      let [workpieces, chat] = await Promise.all([
        listWorkpieces(overseer),
        requireChat(overseer, chatId),
      ]);
      let gadget = requireGadget(workpieces, gadgetId);

      if (chat.activeAgent) {
        throw new ToolError(
            `Chat ${chatId} has an agent turn in progress (${chat.activeAgent.name}). ` +
            `Code changes are rejected while an agent is running; wait for it to finish and retry.`);
      }

      // A chat with no code base yet reads as {generation: 0, revision: 0, pins: []}.
      let codeBase = chat.codeBase;
      let generation = codeBase?.generation ?? 0;
      let revision = codeBase?.revision ?? 0;

      // A gadget joins the chat's change stream by being pinned at its current head the first time
      // its code is modified. Declare the pin only on that first touch: re-declaring an existing
      // pin, or pinning a gadget still pending in this chat (which has no head to pin), is invalid.
      let alreadyPinned = (codeBase?.pins ?? []).some(pin => pin.gadgetId === gadgetId);
      let pins = (!alreadyPinned && gadget.commitId !== undefined)
          ? [{ gadgetId, baseCommit: gadget.commitId }]
          : undefined;

      // A whole-file write is a `set`: valid against any prior state (missing file included), so it
      // can never mis-anchor the way a positional edit could.
      let change: FileChange = { set: args.content as string };
      let submission: CodeChangeSubmission = {
        generation,
        revision,
        // Each MCP call is its own editing session -- there is no state carried between requests to
        // number a longer sequence against -- so a fresh clientId with seq 1 is the honest
        // description of it. The cost is that the server's idempotency window can't recognize a
        // retried MCP call as a duplicate; a retry writes the same content again, which for a
        // whole-file `set` is harmless.
        clientId: crypto.randomUUID(),
        seq: 1,
        ...(pins ? { pins } : {}),
        change: { [gadgetId]: [[args.path as string, change]] },
      };

      let accepted;
      try {
        accepted = await overseer.submitCodeChange(chatId, submission);
      } catch (error) {
        if (isAgentBusy(error)) {
          throw new ToolError(
              `Chat ${chatId} is busy: an agent turn started while this write was in flight. ` +
              `Retry once the agent has finished.`);
        }
        throw new ToolError(
            `Could not write ${args.path}: ` +
            (error instanceof Error ? error.message : String(error)));
      }

      return jsonResult({
        written: args.path,
        gadgetId,
        chatId,
        generation: accepted.generation,
        revision: accepted.revision,
        pinned: pins?.[0]?.baseCommit,
        note: "Proposed only. Call accept_changes to commit this chat's changes.",
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "accept_changes",
    title: "Accept chat changes",
    description:
        "Accept a chat's proposed changes, fast-forwarding every gadget it touched. " +
        "If the chat has gone stale (someone else's changes landed first) this updates the chat " +
        "from mainline and reports any conflicts instead of merging; resolve them with write_file " +
        "and call accept_changes again.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        chatId: { type: "integer", description: "Chat whose changes to accept." },
      },
      required: ["workspaceId", "chatId"],
      additionalProperties: false,
    },
    scopes: ["code:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let chatId = args.chatId as number;
      await requireChat(overseer, chatId);

      let result = await overseer.mergeChanges(chatId);
      if (result.outcome === "merged") {
        return jsonResult({ outcome: "merged", chatId });
      }

      // "stale" is ordinary control flow, not an error: mainline moved past one of the chat's
      // pins. Pull mainline in so the caller has something to resolve, then report.
      let { conflictPaths } = await overseer.updateChatFromMainline(chatId);
      if (conflictPaths.length === 0) {
        return jsonResult({
          outcome: "updated-from-mainline",
          chatId,
          note: "The chat was behind mainline and has been updated cleanly. " +
              "Call accept_changes again to merge.",
        });
      }
      return jsonResult({
        outcome: "conflicts",
        chatId,
        conflictPaths,
        note: "The chat was behind mainline. The listed files were merged with inline 3-way " +
            "conflict markers (<<<<<<< / ||||||| / ======= / >>>>>>>). Read them, resolve each " +
            "with write_file, then call accept_changes again. Paths are qualified by the " +
            "gadget's binding name.",
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "list_chats",
    title: "List chats",
    description: "List a workspace's chat threads, including whether each has proposed changes " +
        "waiting to be accepted and whether an agent is currently running in it.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: workspaceIdParam },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    scopes: ["chats:read"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let chats = await overseer.listChats();
      return jsonResult({
        chats: chats.map(chat => ({
          id: chat.id,
          title: chat.title,
          started: chat.started,
          lastActive: chat.lastActive,
          hasProposedChanges: chat.hasProposedChanges ?? false,
          agentRunning: chat.activeAgent !== undefined,
          ...(chat.activeAgent ? { activeAgent: chat.activeAgent.name } : {}),
          ...(chat.totalCost === undefined ? {} : { totalCost: chat.totalCost }),
        })),
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "send_message",
    title: "Send chat message",
    description:
        "Send a message to a workspace chat, starting a new chat when no chatId is given. " +
        "This STARTS an agent turn and returns immediately -- it does not wait for the reply. " +
        "Poll read_chat (or list_chats, whose agentRunning flag clears when the turn ends) to see " +
        "what the agent did.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        text: { type: "string", description: "The message to send." },
        chatId: {
          type: "integer",
          description: "Existing chat to send into. Omit to start a new chat.",
        },
        modelId: {
          type: "string",
          description:
              "Model to answer with, from the ids the deployment offers. Omit to use the user's " +
              "preferred model. Pass \"none\" to record the message without running any agent.",
        },
      },
      required: ["workspaceId", "text"],
      additionalProperties: false,
    },
    scopes: ["chats:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      // `null` is the API's "record the message, don't run an agent". Spelling that as a magic
      // string keeps the JSON Schema honest (an optional string, not a nullable one).
      let modelId: string | null;
      if (args.modelId === "none") {
        modelId = null;
      } else if (typeof args.modelId === "string") {
        modelId = args.modelId;
      } else {
        modelId = await ctx.api.getPreferredModel();
        if (modelId === null) {
          let available = (await overseer.listModels()).map(model => model.id);
          throw new ToolError(
              "No preferred model is configured for this account, so there is nothing to answer " +
              "with. Pass modelId explicitly" +
              (available.length ? ` (available: ${available.join(", ")})` : "") +
              `, or pass "none" to record the message without running an agent.`);
        }
      }

      if (args.chatId !== undefined) {
        let chatId = args.chatId as number;
        await requireChat(overseer, chatId);
        await overseer.sendChatMessage(chatId, args.text as string, modelId);
        return jsonResult({
          chatId, started: modelId !== null,
          note: "Message sent. The agent (if any) runs asynchronously; poll read_chat.",
        });
      }

      let chatId = await overseer.newChat(args.text as string, modelId);
      return jsonResult({
        chatId, started: modelId !== null,
        note: "New chat started. The agent (if any) runs asynchronously; poll read_chat.",
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "read_chat",
    title: "Read chat history",
    description:
        "Read a chat's transcript as flattened text, oldest message first. Long threads are " +
        "returned one compaction-delimited page at a time; when the result carries " +
        "compactedTo, pass it as beforeSequence to read the page before it.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        chatId: { type: "integer", description: "Chat to read." },
        beforeSequence: {
          type: "integer",
          description: "Read the page ending just before this sequence number.",
        },
      },
      required: ["workspaceId", "chatId"],
      additionalProperties: false,
    },
    scopes: ["chats:read"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let chatId = args.chatId as number;
      let chat = await requireChat(overseer, chatId);
      let page = await overseer.getChatHistory(
          chatId, args.beforeSequence as number | undefined);
      return jsonResult({
        chatId,
        title: chat.title,
        agentRunning: chat.activeAgent !== undefined,
        hasProposedChanges: chat.hasProposedChanges ?? false,
        messages: page.messages.map(flattenChatMessage),
        ...(page.compacted === undefined ? {} : {
          compactedTo: page.compacted.to,
          compactionSummary: page.compacted.summary,
        }),
      });
    }),
  }),

  defineTool<McpToolContext>({
    name: "publish_blueprint",
    title: "Publish blueprint",
    description:
        "Publish a gadget as a blueprint: a reusable snapshot of its code and binding " +
        "requirements that install_blueprint can instantiate into a new workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: workspaceIdParam,
        gadgetId: { type: "integer", description: "Gadget to publish." },
        title: { type: "string", description: "Blueprint title. Defaults to the gadget's title." },
        description: { type: "string", description: "What the blueprint is for." },
      },
      required: ["workspaceId", "gadgetId"],
      additionalProperties: false,
    },
    scopes: ["blueprints:write"],
    handler: (args, ctx) => withWorkspace(ctx, args.workspaceId as string, async overseer => {
      let gadgetId = args.gadgetId as WorkpieceId;
      requireGadget(await listWorkpieces(overseer), gadgetId);
      let gadget = await overseer.getGadget(gadgetId) as unknown as GadgetClient;
      try {
        // No screenshot: capturing one means rendering the gadget's UI, which needs a browser.
        let summary = await gadget.createBlueprint(
            args.title as string | undefined, args.description as string | undefined);
        return jsonResult({ blueprint: summary });
      } finally {
        disposeQuietly(gadget);
      }
    }),
  }),

  defineTool<McpToolContext>({
    name: "install_blueprint",
    title: "Install blueprint",
    description:
        "Instantiate a blueprint into a brand-new workspace. Every binding the blueprint requires " +
        "must be supplied in `bindings`, keyed by binding name; list_blueprints reports what a " +
        "blueprint requires.",
    inputSchema: {
      type: "object",
      properties: {
        blueprintId: { type: "string", description: "Blueprint id, from list_blueprints." },
        bindings: {
          type: "object",
          description:
              "Binding assignments keyed by binding name, e.g. " +
              "{\"github\": {\"accountId\": 3}} or {\"model\": {\"modelId\": \"gpt-5.1\"}}. " +
              "Omit when the blueprint requires no bindings.",
        },
      },
      required: ["blueprintId"],
      additionalProperties: false,
    },
    scopes: ["workspaces:write"],
    handler: async (args, ctx) => {
      let bindings =
          (args.bindings as Record<string, BlueprintBindingAssignment> | undefined) ?? {};
      // The call itself is inside the try: its expected failures -- an unknown blueprint id, a
      // required binding left unassigned -- are the whole reason this tool reports a ToolError, and
      // leaving it outside would let exactly those escape as protocol errors instead.
      let overseer: Overseer | undefined;
      try {
        overseer = await ctx.api.newGadgetFromBlueprint(
            args.blueprintId as string, bindings) as unknown as Overseer;
        let metadata = await overseer.getMetadata();
        return jsonResult({ workspace: workspaceSummary(metadata) });
      } catch (error) {
        throw new ToolError(
            `Could not install blueprint ${args.blueprintId}: ` +
            (error instanceof Error ? error.message : String(error)));
      } finally {
        disposeQuietly(overseer);
      }
    },
  }),

  defineTool<McpToolContext>({
    name: "list_blueprints",
    title: "List blueprints",
    description:
        "List the blueprints available to install: the user's own, the ones they have added to " +
        "their library, and the ones this deployment features.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scopes: ["blueprints:read"],
    handler: async (_args, ctx) => {
      let [own, library, featured] = await Promise.all([
        ctx.api.listOwnBlueprints(),
        ctx.api.listLibraryBlueprints(),
        ctx.api.listFeaturedBlueprints(),
      ]);
      return jsonResult({ own, library, featured });
    },
  }),

  defineTool<McpToolContext>({
    name: "outputs_list",
    title: "List outputs",
    description:
        "List everything the user's workspaces have produced -- documents, apps, and so on -- " +
        "across every workspace, so an output can be found without knowing which workspace made it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    scopes: ["workspaces:read"],
    handler: async (_args, ctx) => {
      // The index is swept in from older workspaces a bounded number at a time, so a single call
      // can return a partial list with `catchingUp` set. Loop until it clears -- bounded, because a
      // sweep that reaches nothing gives up rather than spinning.
      let outputs;
      let attempts = 0;
      do {
        let result = await ctx.api.listOutputs();
        outputs = result.outputs;
        if (!result.catchingUp) break;
      } while (++attempts < 10);

      return jsonResult({
        outputs: outputs.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()),
      });
    },
  }),
];
