// Context Library gatekeeper. It auto-provisions one account per user; each account provides an
// unnamed agent capsule (ContextGatekeeper) and a management UI (ContextApi). Data is sharing-domain
// scoped by binding props.

import { WorkerEntrypoint, DurableObject, RpcStub as NativeRpcStub, RpcTarget as NativeRpcTarget } from "cloudflare:workers";
import { RpcStub } from "capnweb";
import { validateRpc, skipRpcValidation } from "capnweb-validate";
import type {
  VendorDescription, AccountDescription, AgentCatalog,
  AppUiContext, GatekeeperUser, GatekeeperUiFrame, ApprovalQueue, ObservationAuthorizer,
  GatekeeperConnectCallback, GatekeeperConnectOptions, SupportedResource,
  Gatekeeper, GatekeeperUserVerifier, ResourceDescription, ActionKind, ActionDescription,
  SlashCommandDescriptor, SlashCommandProvider, SlashCommandResult,
} from "@gadgets/workshop-shared/gatekeeper";
import { LibraryReadSession } from "./library-read.js";
import { ContextApiImpl, loadEnabledContextCollections } from "./context-api.js";
import { ContextObserverTracker } from "./context-observers.js";
import type { ContextVerifierApi } from "./context-observers.js";
import {
  buildAgentSkillCommands, buildAgentSkillMessage, buildContextCatalog, parseSkillManifest,
  type CollectionSkills,
} from "./agent-skill.js";
import {
  contentTypeFromPath, MAX_DOCUMENT_BODY_BYTES,
  type ContextDocument, type EnabledCollectionInfo,
} from "./context-types.js";
import { validateDocumentPath } from "./context-collection.js";
import { encodeStoredContextBody } from "./context-storage.js";
import { domainName, DEFAULT_SHARING_DOMAIN } from "./domain.js";
import APP_HTML from "./generated/app.txt";

// The Context Library icon: the Phosphor "BookOpen" glyph as a self-contained SVG data URI (no
// external/branded asset), matching AvatarImage's { url } shape.
const LIBRARY_ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0," +
    "0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0," +
    "232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81," +
    "39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z'/>" +
    "</svg>"),
};

const COLLECTION_SKILL_FANOUT = 8;

class ContextSlashCommandProvider extends NativeRpcTarget
    implements SlashCommandProvider {
  constructor(
    private listCommands: () => Promise<SlashCommandDescriptor[]>,
    private invokeCommand: (
      id: string,
      args: string,
      authorizer: NativeRpcStub<ObservationAuthorizer>,
    ) => Promise<SlashCommandResult>,
  ) {
    super();
  }

  list(): Promise<SlashCommandDescriptor[]> {
    return this.listCommands();
  }

  invoke(
      id: string,
      args: string,
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<SlashCommandResult> {
    return this.invokeCommand(id, args, authorizer);
  }

  [Symbol.dispose]() {}
}

// Agent-facing API returned by describeBinding(). Keep these shapes in sync with context-types.ts.
const CONTEXT_LIBRARY_TYPES = `
/**
 * Shared context documents and skills. Catalog entries provide document IDs accepted by read().
 * Each call records an observation.
 */
interface ContextLibrary {
  /** Full-text search across the collections available to you. Returns documents (with docIds). */
  search(query: string, opts?: { collectionId?: string; limit?: number }): Promise<ContextSearchResult[]>;
  /** Browse the tree: no args lists collections (by collectionId); pass a collectionId (and optional
   *  path) to drill in and get the documents (with docIds) inside it. */
  list(opts?: { collectionId?: string; path?: string }): Promise<ContextListing>;
  /** Read a document by an ID from the catalog, search(), or list(). */
  read(docId: string): Promise<ContextDocument | null>;
  /** Create or replace a document in one of your private, web-backed collections. The action is
   *  submitted through the normal approval queue before storage changes. */
  write(collectionId: string, path: string, doc: {
    description: string;
    body: string;
    contentType?: string;
  }): Promise<void>;
  /** Remove one document from one of your private, web-backed collections after approval. */
  remove(collectionId: string, path: string): Promise<void>;
  /** Move one document to a new path in one of your private, web-backed collections after approval. */
  move(collectionId: string, fromPath: string, toPath: string): Promise<void>;
}

interface ContextSearchResult {
  docId: string;          // opaque id to pass to read()
  collectionId?: string;
  title: string;
  path?: string;          // e.g. "billing/revenue.md"
  description?: string;
  snippet?: string;       // matched excerpt
  score?: number;         // higher is more relevant
}

type ContextListingEntry =
  // A collection: its id is a collectionId — pass it to list()/search() to see inside, not read().
  | { type: "collection"; id: string; title: string; description?: string; documentCount: number }
  | { type: "directory"; path: string; name: string }
  // A document: its docId is what read() takes.
  | { type: "document"; docId: string; path: string; name: string; description?: string; contentType?: string };

interface ContextListing {
  collectionId?: string;
  path?: string;
  entries: ContextListingEntry[];
}

interface ContextDocument {
  docId: string;
  title: string;
  path?: string;
  description?: string;
  content: string;        // text (markdown/etc.) or a data: URI for binary content
}
`;

const CONTEXT_WRITE_ACTION_KIND: ActionKind = {
  tag: "context.write",
  label: "Write Context documents",
};

type ContextActionPayload = {
  kind: "write";
  collectionId: string;
  path: string;
  document: { description: string; body: string; contentType: string };
  previous: ContextDocument | null;
} | {
  kind: "remove";
  collectionId: string;
  path: string;
  previous: ContextDocument;
} | {
  kind: "move";
  collectionId: string;
  fromPath: string;
  toPath: string;
};

type StoredContextAction = ContextActionPayload & {
  id: number;
  status: "pending" | "applied";
};

function contentPreview(body: string): string {
  const limit = 8_000;
  let preview = body.slice(0, limit);
  return preview + (body.length > limit ? `\n\n… ${body.length - limit} more character(s)` : "");
}

// Persisted account props. No user identity; private data keys by accountId within the domain.
type ContextAccountProps = {
  sharingDomain: string;
  accountId: string;
};

// Per-user Context capability: declares the singleton read path and management UI.
@validateRpc()
export class ContextAccount
    extends WorkerEntrypoint<Cloudflare.Env, ContextAccountProps>
    implements GatekeeperUser {
  #collections() { return this.ctx.exports.ContextCollectionDurableObject; }
  #userLibraries() { return this.ctx.exports.UserLibraryDurableObject; }
  #registries() { return this.ctx.exports.LibraryRegistryDurableObject; }

  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Context",
      avatar: LIBRARY_ICON,
      singleton: { tsType: "ContextLibrary" },
      providesUi: { title: "Context & Skills", icon: LIBRARY_ICON },
    };
  }

  /** Return the gadget-side read-path class, scoped by this account's props. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    return this.ctx.exports.ContextGatekeeper({
      props: { sharingDomain: this.ctx.props.sharingDomain, accountId: this.ctx.props.accountId },
    });
  }

  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    // Hand the iframe its per-user UI capability. isAdmin is supplied fresh per open.
    let ui = new RpcStub(new ContextApiImpl(
      this.env, this.ctx.props.sharingDomain, this.ctx.props.accountId, context.isAdmin,
      this.#collections(), this.#userLibraries(), this.#registries()));
    // Bundled file-manager SPA (generated by build-app.mjs).
    return { iframeHtml: APP_HTML, ui };
  }

  /** --- GatekeeperUser resource surface (no URL-addressed resources) --- */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Context Library has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): never {
    throw new Error("The Context Library has no URL-addressed resources.");
  }
  /** No grantable resource types, so nothing to authorize and no URL to return. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{url?: string}> {
    return {};
  }
  /** Delete private collections; public collections are domain-owned. */
  async revoke(): Promise<void> {
    let domain = this.ctx.props.sharingDomain;
    let userLibrary = this.#userLibraries().get(
      this.#userLibraries().idFromName(domainName(domain, this.ctx.props.accountId)));
    let owned = await userLibrary.listOwnedCollections();
    // Delete collection storage; wipe the library index once below.
    await Promise.all(owned.map(collection =>
      this.#collections().get(this.#collections().idFromName(domainName(domain, collection.id)))
          .deleteForRevokedOwner()));
    // Clear any residual library state.
    await userLibrary.deleteAll();
  }
  reconnect(): never {
    throw new Error("The Context Library is a singleton gatekeeper; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /**
   * Mint a verifier tied to this account. ContextGatekeeper uses it to check whether a prospective
   * observer can independently read each collection the Gadget has observed.
   */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ContextVerifier({ props: this.ctx.props });
  }
}

@validateRpc()
export class ContextVerifier
    extends WorkerEntrypoint<Cloudflare.Env, ContextAccountProps>
    implements ContextVerifierApi {
  async hasCollectionAccess(sharingDomain: string, collectionId: string): Promise<boolean> {
    if (sharingDomain !== this.ctx.props.sharingDomain) return false;
    let userLibraries = this.ctx.exports.UserLibraryDurableObject;
    let registries = this.ctx.exports.LibraryRegistryDurableObject;
    let [owns, isPublic] = await Promise.all([
      userLibraries.get(userLibraries.idFromName(
        domainName(sharingDomain, this.ctx.props.accountId))).hasOwned(collectionId),
      registries.getByName(sharingDomain).isPublic(collectionId),
    ]);
    return owns || isPublic;
  }
}

// Gadget-side Context path. Reads are observation-audited; mutations are staged through the
// approval queue and restricted to private web collections owned by this account.
@validateRpc()
export class ContextGatekeeper
    extends DurableObject<Cloudflare.Env, ContextAccountProps>
    implements Gatekeeper<LibraryReadSession> {
  #collections() { return this.ctx.exports.ContextCollectionDurableObject; }
  #userLibraries() { return this.ctx.exports.UserLibraryDurableObject; }
  #observers() {
    return new ContextObserverTracker(this.ctx.storage.kv, this.ctx.props.sharingDomain);
  }

  #actionKey(id: number): string { return `action:${id}`; }

  #nextActionId(): number {
    let id = (this.ctx.storage.kv.get<number>("actionCounter") ?? 0) + 1;
    this.ctx.storage.kv.put("actionCounter", id);
    return id;
  }

  async #ownedWebCollection(collectionId: string) {
    let domain = this.ctx.props.sharingDomain;
    let userLibrary = this.#userLibraries().get(
      this.#userLibraries().idFromName(domainName(domain, this.ctx.props.accountId)));
    if (!(await userLibrary.hasOwned(collectionId))) {
      throw new Error(
        "Agents may only write private Context collections owned by this account.");
    }
    let collection = this.#collections().get(
      this.#collections().idFromName(domainName(domain, collectionId)));
    let metadata = await collection.getMetadata();
    if (metadata.content.source !== "web") {
      throw new Error("Git-backed Context collections must be changed through git.");
    }
    return { collection, metadata };
  }

  async #enqueue(
      queue: NativeRpcStub<ApprovalQueue>, payload: ContextActionPayload,
      description: ActionDescription): Promise<void> {
    let id = this.#nextActionId();
    this.ctx.storage.kv.put<StoredContextAction>(
      this.#actionKey(id), { ...payload, id, status: "pending" });
    try {
      await queue.submitAction(id, description);
    } catch (error) {
      this.ctx.storage.kv.delete(this.#actionKey(id));
      throw error;
    }
  }

  async #stageWrite(
      queue: NativeRpcStub<ApprovalQueue>, collectionId: string, path: string,
      doc: { description: string; body: string; contentType?: string }): Promise<void> {
    validateDocumentPath(path);
    let contentType = doc.contentType || contentTypeFromPath(path);
    let encodedBody = encodeStoredContextBody(contentType, doc.body);
    if (encodedBody.byteLength > MAX_DOCUMENT_BODY_BYTES) {
      throw new Error(
        `Document is too large (${encodedBody.byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`);
    }
    let { collection, metadata } = await this.#ownedWebCollection(collectionId);
    let previous = await collection.getContextDocument(path);
    await this.#enqueue(queue, {
      kind: "write",
      collectionId,
      path,
      document: { description: doc.description, body: doc.body, contentType },
      previous,
    }, {
      title: `${previous ? "Update" : "Create"} Context document: ${path}`,
      description:
        `${previous ? "Replace" : "Create"} \`${path}\` in **${metadata.title}**.\n\n` +
        `**When to use this:** ${doc.description || "Not specified"}\n\n` +
        `\`\`\`${contentType}\n${contentPreview(doc.body)}\n\`\`\``,
      implementsRevert: true,
      awaitDecision: true,
      autoApprovable: true,
      actionKind: CONTEXT_WRITE_ACTION_KIND,
    });
  }

  async #stageRemove(
      queue: NativeRpcStub<ApprovalQueue>, collectionId: string, path: string): Promise<void> {
    validateDocumentPath(path);
    let { collection, metadata } = await this.#ownedWebCollection(collectionId);
    let previous = await collection.getContextDocument(path);
    if (!previous) throw new Error(`Document not found: ${path}`);
    await this.#enqueue(queue, { kind: "remove", collectionId, path, previous }, {
      title: `Remove Context document: ${path}`,
      description: `Remove \`${path}\` from **${metadata.title}**.`,
      implementsRevert: true,
      awaitDecision: true,
    });
  }

  async #stageMove(
      queue: NativeRpcStub<ApprovalQueue>, collectionId: string, fromPath: string,
      toPath: string): Promise<void> {
    validateDocumentPath(fromPath);
    validateDocumentPath(toPath);
    let { collection, metadata } = await this.#ownedWebCollection(collectionId);
    if (!(await collection.getContextDocument(fromPath))) {
      throw new Error(`Document not found: ${fromPath}`);
    }
    if (await collection.getContextDocument(toPath)) {
      throw new Error(`Destination already exists: ${toPath}`);
    }
    await this.#enqueue(queue, { kind: "move", collectionId, fromPath, toPath }, {
      title: `Move Context document: ${fromPath}`,
      description: `Move \`${fromPath}\` to \`${toPath}\` in **${metadata.title}**.`,
      implementsRevert: true,
      awaitDecision: true,
    });
  }

  async #loadSkills(
      collections: EnabledCollectionInfo[]):
      Promise<CollectionSkills[]> {
    let result: CollectionSkills[] = [];
    for (let offset = 0; offset < collections.length; offset += COLLECTION_SKILL_FANOUT) {
      let batch = await Promise.all(
        collections.slice(offset, offset + COLLECTION_SKILL_FANOUT).map(async collection => {
          try {
            let id = this.#collections().idFromName(
                domainName(this.ctx.props.sharingDomain, collection.id));
            let skills = await this.#collections().get(id).listAgentSkills();
            return {collection, skills};
          } catch (error) {
            console.error("Failed to load skills from Context collection:", {
              collectionId: collection.id,
              error,
            });
            return null;
          }
        }));
      for (let entry of batch) {
        if (entry) result.push(entry);
      }
    }
    return result;
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "context://library",
      title: "Context",
      snippet: "Search and read your team's shared context collections.",
      suggestedBindingName: "CONTEXT",
      tsType: "ContextLibrary",
      hasSlashCommands: true,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CONTEXT_LIBRARY_TYPES;
  }

  #newReadSession(authorizer: NativeRpcStub<ObservationAuthorizer>): LibraryReadSession {
    // The read session uses this authorizer after startSession() returns, so it owns a duplicate.
    let ownedAuthorizer = authorizer.dup();
    try {
      return new LibraryReadSession(
        this.#collections(), this.#userLibraries(),
        this.ctx.props.sharingDomain, this.ctx.props.accountId, ownedAuthorizer,
        collectionIds => this.#observers().prepareObservation(collectionIds));
    } catch (err) {
      ownedAuthorizer[Symbol.dispose]?.();
      throw err;
    }
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<LibraryReadSession> {
    let queue = approvalQueue.dup();
    try {
      return new LibraryReadSession(
        this.#collections(), this.#userLibraries(),
        this.ctx.props.sharingDomain, this.ctx.props.accountId, queue,
        collectionIds => this.#observers().prepareObservation(collectionIds),
        {
          write: (collectionId, path, doc) =>
            this.#stageWrite(queue, collectionId, path, doc),
          remove: (collectionId, path) => this.#stageRemove(queue, collectionId, path),
          move: (collectionId, fromPath, toPath) =>
            this.#stageMove(queue, collectionId, fromPath, toPath),
        },
      );
    } catch (error) {
      queue[Symbol.dispose]?.();
      throw error;
    }
  }

  async getSlashCommandProvider():
      Promise<ContextSlashCommandProvider> {
    return new ContextSlashCommandProvider(
        () => this.#listSlashCommands(),
        (id, args, authorizer) => this.#invokeAgentSkillCommand(id, args, authorizer));
  }

  async #listSlashCommands(): Promise<SlashCommandDescriptor[]> {
    let domain = this.ctx.props.sharingDomain;
    let userLibrary = this.#userLibraries().get(
        this.#userLibraries().idFromName(domainName(domain, this.ctx.props.accountId)));
    let collections = (await loadEnabledContextCollections(this.env, domain, userLibrary))
        .toSorted((left, right) =>
          left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
    return buildAgentSkillCommands(await this.#loadSkills(collections));
  }

  async #invokeAgentSkillCommand(
      id: string, args: string, authorizer: NativeRpcStub<ObservationAuthorizer>):
      Promise<SlashCommandResult> {
    using session = this.#newReadSession(authorizer);
    let document = await session.read(id);
    if (!document?.path) throw new Error("The selected Agent Skill is no longer available.");
    let manifest = parseSkillManifest(document.path, document.content);
    return {
      skillName: manifest.name,
      message: buildAgentSkillMessage(id, document.content, args),
    };
  }

  async getAgentCatalog(
      authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog> {
    let domain = this.ctx.props.sharingDomain;
    let userLibrary = this.#userLibraries().get(
      this.#userLibraries().idFromName(domainName(domain, this.ctx.props.accountId)));
    let collections = await loadEnabledContextCollections(this.env, domain, userLibrary);
    let catalog = buildContextCatalog(collections, await this.#loadSkills(collections));
    if (catalog.entries.length > 0) {
      let collectionIds = [...new Set(catalog.entries.map(entry => {
        let slash = entry.id.indexOf("/");
        return slash < 0 ? entry.id : entry.id.slice(0, slash);
      }))];
      let check = await this.#observers().prepareObservation(collectionIds);
      await authorizer.authorizeObservation({
        title: "Context catalog",
        description: `Listed ${catalog.entries.length} available Context item(s).`,
        excludeObservers: check.excludeObservers,
      });
      check.commit();
    }
    return catalog;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [CONTEXT_WRITE_ACTION_KIND];
  }

  /**
   * The Context singleton is a broad binding over public and account-private collections. Track the
   * collections actually revealed and verify every observer against each one.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers().addObserver(
      id, user as unknown as Fetcher<ContextVerifierApi>);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observers().removeObserver(id);
  }

  async applyAction(actionId: number): Promise<void> {
    let action = this.ctx.storage.kv.get<StoredContextAction>(this.#actionKey(actionId));
    if (!action) throw new Error(`Unknown Context action: ${actionId}`);
    if (action.status !== "pending") throw new Error(`Context action ${actionId} is not pending.`);
    let { collection } = await this.#ownedWebCollection(action.collectionId);
    switch (action.kind) {
      case "write":
        await collection.putContextDocument(action.path, action.document);
        break;
      case "remove":
        await collection.deleteContextDocument(action.path);
        break;
      case "move":
        await collection.moveContextDocument(action.fromPath, action.toPath);
        break;
    }
    action.status = "applied";
    this.ctx.storage.kv.put(this.#actionKey(actionId), action);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    this.ctx.storage.kv.delete(this.#actionKey(actionId));
  }

  async revertAction(actionId: number):
      Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    let action = this.ctx.storage.kv.get<StoredContextAction>(this.#actionKey(actionId));
    if (!action) throw new Error(`Unknown Context action: ${actionId}`);
    if (action.status !== "applied") throw new Error(`Context action ${actionId} is not applied.`);
    let { collection } = await this.#ownedWebCollection(action.collectionId);
    switch (action.kind) {
      case "write":
        if (action.previous) {
          await collection.putContextDocument(action.path, action.previous);
        } else if (await collection.getContextDocument(action.path)) {
          await collection.deleteContextDocument(action.path);
        }
        break;
      case "remove":
        await collection.putContextDocument(action.path, action.previous);
        break;
      case "move":
        await collection.moveContextDocument(action.toPath, action.fromPath);
        break;
    }
    this.ctx.storage.kv.delete(this.#actionKey(actionId));
  }
}

// Vendor entrypoint. Binding props carry the sharing domain.
type GatekeeperVendorProps = {
  // Set on the core->gatekeeper service binding.
  sharingDomain?: string;
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env, GatekeeperVendorProps> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Context",
      url: "https://workers.cloudflare.com/",
      logo: LIBRARY_ICON,
      tagline: "Author and consult shared context collections",
      description:
        "The Context Library lets you and your team author collections of context documents " +
        "that agents can consult to learn how to perform tasks. It is always available — no " +
        "connection needed.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /**
   * Mint a fresh account capability with no user identity.
   *
   * Skip return validation: proxy-wrapping a WorkerEntrypoint stub breaks Workers serialization.
   */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    let sharingDomain = this.ctx.props.sharingDomain ?? DEFAULT_SHARING_DOMAIN;
    return this.ctx.exports.ContextAccount({
      props: { sharingDomain, accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  // --- Resource-connection GatekeeperVendor surface (not applicable to this vendor) ---

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>,
                 _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("The Context Library is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    // Empty: auto-provisioned singleton accounts don't expose URL-addressed resources.
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return CONTEXT_LIBRARY_TYPES;
  }
}
