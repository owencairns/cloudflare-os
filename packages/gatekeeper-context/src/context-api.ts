// Per-account management API exposed to the library iframe. Users manage their own private
// collections; admins also manage public collections. Everything is sharing-domain scoped.

import { RpcTarget } from "capnweb";
import { validateRpc } from "capnweb-validate";
import {
  ContextApi, ContextCollectionContent, ContextCollectionMetadata, ContextCollectionVisibility,
  ContextDocument, ContextDocumentSummary, ContextGitTokenCreateResult, ContextGitTokenList,
  ContextLibraryBackup, ContextLibraryImportResult, ContextSearchResult,
  DEFAULT_GIT_BRANCH, EnabledCollectionInfo, encodeDocId,
} from "./context-types.js";
import { normalizeContextLibraryBackup } from "./context-backup.js";
import type { ContextCollectionDurableObject } from "./context-collection.js";
import type { UserLibraryDurableObject } from "./user-library.js";
import type { LibraryRegistryDurableObject } from "./registry-do.js";
import {
  listPublicCollectionsFromKv, metadataToSummary,
} from "./collection-kv.js";
import { domainName } from "./domain.js";

/** Collections visible to this account's agents. */
export async function loadEnabledContextCollections(
    env: Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">,
    domain: string,
    userLibrary: DurableObjectStub<UserLibraryDurableObject>): Promise<EnabledCollectionInfo[]> {
  let [owned, publicCollections] = await Promise.all([
    userLibrary.listOwnedCollections(),
    listPublicCollectionsFromKv(env, domain),
  ]);

  let result: EnabledCollectionInfo[] = [];
  let seen = new Set<string>();
  for (let collection of owned) {
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "private",
      lastUpdated: collection.lastUpdated,
    });
  }
  for (let collection of publicCollections) {
    if (seen.has(collection.id)) continue;
    seen.add(collection.id);
    result.push({
      id: collection.id,
      title: collection.title,
      description: collection.description,
      icon: collection.icon,
      source: "public",
      lastUpdated: collection.lastUpdated,
    });
  }
  return result;
}

@validateRpc()
export class ContextApiImpl extends RpcTarget implements ContextApi {
  constructor(
    private env: Cloudflare.Env,
    private domain: string,
    private accountId: string,
    private isAdmin: boolean,
    private collections: DurableObjectNamespace<ContextCollectionDurableObject>,
    private userLibraries: DurableObjectNamespace<UserLibraryDurableObject>,
    private registries: DurableObjectNamespace<LibraryRegistryDurableObject>,
  ) {
    super();
  }

  #collection(id: string) {
    return this.collections.get(this.collections.idFromName(domainName(this.domain, id)));
  }

  #userLib() {
    return this.userLibraries.get(this.userLibraries.idFromName(domainName(this.domain, this.accountId)));
  }

  #registry() {
    return this.registries.getByName(this.domain);
  }

  // Whether this account owns the private collection.
  async #ownsPrivate(collectionId: string): Promise<boolean> {
    return this.#userLib().hasOwned(collectionId);
  }

  // Read: own private collections or any public collection.
  async #assertCanRead(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (!owns && !isPublic) {
      throw new Error("Collection not found or you don't have access.");
    }
  }

  // Write: own private collections, or public collections for admins.
  async #assertCanWrite(collectionId: string): Promise<void> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    if (owns) return;
    if (isPublic && this.isAdmin) return;
    throw new Error("Collection not found or you don't have access.");
  }

  #assertArtifactsAvailable(): void {
    if (!this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }
  }

  #assertAdmin(): void {
    if (!this.isAdmin) throw new Error("Admin access required.");
  }

  async getViewerInfo(): Promise<{ isAdmin: boolean; supportsGitCollections: boolean }> {
    return { isAdmin: this.isAdmin, supportsGitCollections: !!this.env.ARTIFACTS };
  }

  // --- Collection management ---

  async createContextCollection(
    title: string,
    description: string,
    visibility: ContextCollectionVisibility,
    icon?: string,
    source: ContextCollectionContent["source"] = "web",
  ): Promise<ContextCollectionMetadata> {
    if (visibility === "public") this.#assertAdmin();
    if (source !== "web" && source !== "git") {
      throw new Error(`Unsupported collection source: ${source}`);
    }
    if (source === "git" && !this.env.ARTIFACTS) {
      throw new Error("Git-backed Context collections are not enabled.");
    }

    let id = crypto.randomUUID();
    let metadata: ContextCollectionMetadata = {
      id,
      icon,
      title,
      description,
      visibility,
      created: new Date(),
      lastUpdated: new Date(),
      documentCount: 0,
      content: source === "git"
        ? { source, remote: "", branch: DEFAULT_GIT_BRANCH, lastRefreshedAt: new Date() }
        : { source },
    };

    return this.#createContextCollection(metadata);
  }

  async #createContextCollection(
      metadata: ContextCollectionMetadata): Promise<ContextCollectionMetadata> {
    let { id, title, description, icon, visibility } = metadata;
    // Initialize before indexing; if this fails, nothing is reachable yet.
    metadata = await this.#collection(id).initialize(metadata, this.domain, visibility === "private" ? this.accountId : "");

    // Private collections live in the owner's library; public ones live in the domain registry.
    try {
      if (visibility === "public") {
        await this.#registry().addPublic(this.domain, metadataToSummary(metadata));
      } else {
        await this.#userLib().createOwnedCollection(id, title, description, icon);
      }
    } catch (err) {
      // Indexing failed; delete the now-unreachable collection.
      await this.#collection(id).deleteSelf().catch(() => {});
      throw err;
    }
    return metadata;
  }

  async updateContextCollection(collectionId: string, options: {
    title?: string; description?: string; icon?: string; branch?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    if (options.branch !== undefined) this.#assertArtifactsAvailable();
    await this.#collection(collectionId).updateMetadata(options);
  }

  async syncContextCollectionArtifactSource(collectionId: string): Promise<void> {
    // Only collection owners/admins can manually trigger an artifact
    // sync. Read requests from non-owners/admins may trigger a
    // stale-while-revalidate sync in the background, but they do not
    // have direct control over this.
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    await this.#collection(collectionId).syncArtifactSource();
  }

  async createContextCollectionGitToken(collectionId: string): Promise<ContextGitTokenCreateResult> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).createGitToken();
  }

  async listContextCollectionGitTokens(collectionId: string): Promise<ContextGitTokenList> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).listGitTokens();
  }

  async revokeContextCollectionGitToken(collectionId: string, tokenId: string): Promise<boolean> {
    await this.#assertCanWrite(collectionId);
    this.#assertArtifactsAvailable();
    return this.#collection(collectionId).revokeGitToken(tokenId);
  }

  async deleteContextCollection(collectionId: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteSelf();
  }

  async getContextCollectionMetadata(collectionId: string): Promise<ContextCollectionMetadata | null> {
    try {
      let [meta, owns, isPublic] = await Promise.all([
        this.#collection(collectionId).getMetadata(),
        this.#ownsPrivate(collectionId),
        this.#registry().isPublic(collectionId),
      ]);
      if (!meta.id || (!owns && !isPublic)) return null;
      return meta;
    } catch {
      return null;
    }
  }

  // --- Document editing ---

  async listContextDocuments(collectionId: string, prefix?: string): Promise<ContextDocumentSummary[]> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).listContextDocuments(prefix);
  }

  async getContextDocument(collectionId: string, path: string): Promise<ContextDocument | null> {
    await this.#assertCanRead(collectionId);
    return this.#collection(collectionId).getContextDocument(path);
  }

  async putContextDocument(collectionId: string, path: string, doc: {
    description: string; body: string; contentType?: string;
  }): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).putContextDocument(path, doc);
  }

  async deleteContextDocument(collectionId: string, path: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).deleteContextDocument(path);
  }

  async moveContextDocument(collectionId: string, fromPath: string, toPath: string): Promise<void> {
    await this.#assertCanWrite(collectionId);
    await this.#collection(collectionId).moveContextDocument(fromPath, toPath);
  }

  // --- Listing & access ---

  async listEnabledContextCollections(): Promise<EnabledCollectionInfo[]> {
    return loadEnabledContextCollections(this.env, this.domain, this.#userLib());
  }

  async searchContextLibrary(
      query: string,
      options: { collectionId?: string; limit?: number } = {}): Promise<ContextSearchResult[]> {
    let enabled = await this.listEnabledContextCollections();
    let targets = options.collectionId
      ? enabled.filter(collection => collection.id === options.collectionId)
      : enabled;
    let limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    let hits = (await Promise.all(targets.map(async collection =>
      (await this.#collection(collection.id).search(query, limit)).map(hit => ({
        docId: encodeDocId(collection.id, hit.path),
        collectionId: collection.id,
        title: hit.name,
        path: hit.path,
        description: hit.description,
        snippet: hit.snippet,
        score: hit.score,
      })),
    ))).flat();
    return hits.toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0)).slice(0, limit);
  }

  async canWriteContextCollection(collectionId: string): Promise<boolean> {
    let [owns, isPublic] = await Promise.all([
      this.#ownsPrivate(collectionId),
      this.#registry().isPublic(collectionId),
    ]);
    return owns || (isPublic && this.isAdmin);
  }

  // --- Backup & restore ---

  async exportContextLibrary(): Promise<ContextLibraryBackup> {
    let enabled = await this.listEnabledContextCollections();
    let collections = await Promise.all(enabled.map(async entry => {
      await this.#assertCanRead(entry.id);
      let stub = this.#collection(entry.id);
      let [metadata, summaries] = await Promise.all([
        stub.getMetadata(),
        stub.listContextDocuments(),
      ]);
      let documents = await Promise.all(summaries.map(async summary => {
        let document = await stub.getContextDocument(summary.path);
        if (!document) throw new Error(`Document disappeared during export: ${summary.path}`);
        return {
          path: document.path,
          description: document.description,
          contentType: document.contentType,
          body: document.body,
          lastUpdated: document.lastUpdated.toISOString(),
        };
      }));
      return {
        metadata: {
          id: metadata.id,
          ...(metadata.icon === undefined ? {} : { icon: metadata.icon }),
          title: metadata.title,
          description: metadata.description,
          visibility: metadata.visibility,
          created: metadata.created.toISOString(),
          lastUpdated: metadata.lastUpdated.toISOString(),
          source: metadata.content.source,
        },
        documents,
      };
    }));
    return {
      format: "context-library",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      collections,
    };
  }

  async importContextLibrary(
      input: ContextLibraryBackup,
      options: { mode?: "merge" | "replace" } = {}): Promise<ContextLibraryImportResult> {
    let snapshot = normalizeContextLibraryBackup(input);
    let mode = options.mode ?? "merge";
    if (mode !== "merge" && mode !== "replace") {
      throw new Error("Context import mode must be merge or replace.");
    }
    if (!this.isAdmin && snapshot.collections.some(
      collection => collection.metadata.visibility === "public")) {
      throw new Error("Admin access is required to restore public collections.");
    }

    if (mode === "replace") {
      let enabled = await this.listEnabledContextCollections();
      for (let entry of enabled) {
        if (await this.canWriteContextCollection(entry.id)) {
          await this.#collection(entry.id).deleteSelf();
        }
      }
    }

    let documentCount = 0;
    for (let backup of snapshot.collections) {
      let { metadata: stored, documents } = backup;
      let current = await this.getContextCollectionMetadata(stored.id);
      let metadata: ContextCollectionMetadata = {
        id: stored.id,
        ...(stored.icon === undefined ? {} : { icon: stored.icon }),
        title: stored.title,
        description: stored.description,
        visibility: stored.visibility,
        created: new Date(stored.created),
        lastUpdated: new Date(stored.lastUpdated),
        documentCount: documents.length,
        // Restores are self-contained and writable even when the source snapshot mirrored git.
        content: { source: "web" },
      };
      let normalizedDocuments: ContextDocument[] = documents.map(document => ({
        path: document.path,
        name: document.path.slice(document.path.lastIndexOf("/") + 1),
        description: document.description,
        contentType: document.contentType,
        body: document.body,
        lastUpdated: new Date(document.lastUpdated),
      }));

      if (!current) {
        await this.#createContextCollection(metadata);
        await this.#collection(stored.id).replaceContextDocuments(normalizedDocuments);
      } else {
        await this.#assertCanWrite(stored.id);
        if (current.visibility !== stored.visibility) {
          throw new Error(`Cannot merge collection ${stored.id} with a different visibility.`);
        }
        await this.#collection(stored.id).updateMetadata({
          title: stored.title,
          description: stored.description,
          ...(stored.icon === undefined ? {} : { icon: stored.icon }),
        });
        if (mode === "replace") {
          await this.#collection(stored.id).replaceContextDocuments(normalizedDocuments);
        } else {
          for (let document of normalizedDocuments) {
            await this.#collection(stored.id).putContextDocument(document.path, document);
          }
        }
      }
      documentCount += documents.length;
    }

    return { mode, collections: snapshot.collections.length, documents: documentCount };
  }
}
