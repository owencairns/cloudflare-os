import { describe, expect, it } from "vitest";
import { normalizeContextLibraryBackup } from "../src/context-backup.js";

function snapshot() {
  return {
    format: "context-library",
    schemaVersion: 1,
    exportedAt: "2026-08-25T20:00:00.000Z",
    collections: [{
      metadata: {
        id: "company",
        title: "MyoPlan Company",
        description: "Company operating context.",
        visibility: "private",
        created: "2026-08-25T19:00:00.000Z",
        lastUpdated: "2026-08-25T20:00:00.000Z",
        source: "web",
      },
      documents: [{
        path: "company/agents.md",
        description: "Agent operating guide.",
        contentType: "text/markdown",
        body: "# Agents",
        lastUpdated: "2026-08-25T20:00:00.000Z",
      }],
    }],
  };
}

describe("Context backup validation", () => {
  it("normalizes a portable library snapshot", () => {
    expect(normalizeContextLibraryBackup(snapshot())).toMatchObject({
      format: "context-library",
      schemaVersion: 1,
      collections: [{
        metadata: { id: "company", visibility: "private", source: "web" },
        documents: [{ path: "company/agents.md", body: "# Agents" }],
      }],
    });
  });

  it("rejects unsupported versions before restore", () => {
    expect(() => normalizeContextLibraryBackup({ ...snapshot(), schemaVersion: 2 }))
      .toThrow("Unsupported Context backup format or schema version.");
  });

  it("rejects duplicate collection ids and document paths", () => {
    let duplicateCollection = snapshot();
    duplicateCollection.collections.push(structuredClone(duplicateCollection.collections[0]));
    expect(() => normalizeContextLibraryBackup(duplicateCollection))
      .toThrow("Duplicate collection id: company");

    let duplicateDocument = snapshot();
    duplicateDocument.collections[0].documents.push(
      structuredClone(duplicateDocument.collections[0].documents[0]));
    expect(() => normalizeContextLibraryBackup(duplicateDocument))
      .toThrow("Duplicate document path in company: company/agents.md");
  });

  it("rejects malformed dates and bodies", () => {
    let badDate = snapshot();
    badDate.collections[0].metadata.created = "not-a-date";
    expect(() => normalizeContextLibraryBackup(badDate)).toThrow("must be an ISO date");

    let badBody = snapshot() as ReturnType<typeof snapshot> & {
      collections: Array<{documents: Array<{body: unknown}>}>;
    };
    badBody.collections[0].documents[0].body = 42;
    expect(() => normalizeContextLibraryBackup(badBody)).toThrow("document body must be a string");
  });
});
