import type { ContextCollectionBackup, ContextLibraryBackup } from "./context-types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  return value;
}

function isoDate(value: unknown, label: string): string {
  let result = string(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO date.`);
  return new Date(result).toISOString();
}

/** Validate untrusted JSON before any restore mutates collection storage. */
export function normalizeContextLibraryBackup(value: unknown): ContextLibraryBackup {
  let snapshot = record(value, "Context backup");
  if (snapshot.format !== "context-library" || snapshot.schemaVersion !== 1) {
    throw new Error("Unsupported Context backup format or schema version.");
  }
  if (!Array.isArray(snapshot.collections)) {
    throw new Error("Context backup collections must be an array.");
  }

  let collectionIds = new Set<string>();
  let collections = snapshot.collections.map((rawCollection, collectionIndex): ContextCollectionBackup => {
    let collection = record(rawCollection, `Collection ${collectionIndex + 1}`);
    let metadata = record(collection.metadata, `Collection ${collectionIndex + 1} metadata`);
    let id = string(metadata.id, `Collection ${collectionIndex + 1} id`);
    if (collectionIds.has(id)) throw new Error(`Duplicate collection id: ${id}`);
    collectionIds.add(id);
    let visibility = metadata.visibility;
    if (visibility !== "private" && visibility !== "public") {
      throw new Error(`Collection ${id} visibility must be private or public.`);
    }
    let source = metadata.source;
    if (source !== "web" && source !== "git") {
      throw new Error(`Collection ${id} source must be web or git.`);
    }
    if (!Array.isArray(collection.documents)) {
      throw new Error(`Collection ${id} documents must be an array.`);
    }

    let paths = new Set<string>();
    let documents = collection.documents.map((rawDocument, documentIndex) => {
      let document = record(rawDocument, `Collection ${id} document ${documentIndex + 1}`);
      let path = string(document.path, `Collection ${id} document path`);
      if (paths.has(path)) throw new Error(`Duplicate document path in ${id}: ${path}`);
      paths.add(path);
      return {
        path,
        description: string(
          document.description, `Collection ${id} document description`, true),
        contentType: string(document.contentType, `Collection ${id} document content type`),
        body: string(document.body, `Collection ${id} document body`, true),
        lastUpdated: isoDate(
          document.lastUpdated, `Collection ${id} document lastUpdated`),
      };
    });

    return {
      metadata: {
        id,
        ...(metadata.icon === undefined
          ? {}
          : { icon: string(metadata.icon, `Collection ${id} icon`, true) }),
        title: string(metadata.title, `Collection ${id} title`),
        description: string(metadata.description, `Collection ${id} description`, true),
        visibility,
        created: isoDate(metadata.created, `Collection ${id} created`),
        lastUpdated: isoDate(metadata.lastUpdated, `Collection ${id} lastUpdated`),
        source,
      },
      documents,
    };
  });

  return {
    format: "context-library",
    schemaVersion: 1,
    exportedAt: isoDate(snapshot.exportedAt, "Context backup exportedAt"),
    collections,
  };
}
