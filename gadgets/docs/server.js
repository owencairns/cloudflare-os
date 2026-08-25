// MyoPlan Docs — a path-first document store.
//
// Ports the old MyoPlan HQ notes model onto the OS gadget shape. The RPC methods
// on `Gadget` are the product: agents call write/read/list/search/move/tree over
// the workspace's gadget stub. The browser UI in client.js is a thin
// reader/editor over exactly the same surface.
//
// Identity is the **path**: a slash-separated list of kebab-case segments, e.g.
// `company/decisions/2026-08-23-migrate-hq-onto-cloudflare-os`. Folders are
// implicit — there is no folder table; `tree()` derives the hierarchy from the
// paths that exist.

import { DurableObject } from "cloudflare:workers";

const MAX_SEGMENT = 80;
const MAX_SEGMENTS = 12;

// Backup/restore. `EXPORT_TABLES` is the full storage surface: every table, every column. The
// natural key is `path`, which is what `write()` upserts on. Bump SCHEMA_VERSION only if the
// table/column shape changes.
const SCHEMA_VERSION = 1;
const GADGET_NAME = "docs";
const EXPORT_TABLES = [
  {
    name: "documents",
    key: "path",
    columns: ["id", "path", "title", "body", "tags", "createdAt", "updatedAt"],
  },
];

/**
 * Normalize a document path. Every segment is kebab-cased, so `"Company/ Decisions "`
 * and `"company/decisions"` address the same document. Throws on anything that
 * normalizes to nothing.
 */
function normalizePath(path) {
  const raw = String(path == null ? "" : path);
  const segments = [];
  for (const piece of raw.split("/")) {
    const seg = piece
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SEGMENT)
      .replace(/-+$/g, "");
    if (seg) segments.push(seg);
  }
  if (segments.length === 0) {
    throw new Error(
      `path must contain at least one alphanumeric segment (got ${JSON.stringify(path)})`,
    );
  }
  if (segments.length > MAX_SEGMENTS) {
    throw new Error(`path has too many segments (max ${MAX_SEGMENTS})`);
  }
  return segments.join("/");
}

/** Normalize a path *prefix* — same rules, but an empty prefix is legal (means "everything"). */
function normalizePrefix(prefix) {
  if (prefix == null || String(prefix).trim() === "" || String(prefix).trim() === "/") return "";
  return normalizePath(prefix);
}

function normalizeTags(tags) {
  if (tags == null) return [];
  const input = Array.isArray(tags) ? tags : String(tags).split(",");
  const out = [];
  for (const raw of input) {
    const tag = String(raw)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The last path segment, humanized — the fallback title when none is given. */
function titleFromPath(path) {
  const last = path.split("/").pop();
  return last.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function rowToDocument(row) {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    body: row.body,
    tags: JSON.parse(row.tags || "[]"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function summarize(doc) {
  return {
    path: doc.path,
    title: doc.title,
    tags: doc.tags,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function excerptFor(body, terms) {
  const text = String(body || "");
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return text.slice(0, 160).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - 60);
  const slice = text.slice(start, start + 200).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (start + 200 < text.length ? "…" : "");
}

const SEEDS = [
  {
    path: "company/decisions/2026-08-23-migrate-hq-onto-cloudflare-os",
    title: "Decision: migrate HQ onto Cloudflare OS",
    tags: ["decision", "migration", "infrastructure"],
    body: `# Decision: migrate MyoPlan HQ onto Cloudflare OS

**Decided:** 2026-08-23 · **Status:** in flight

MyoPlan HQ moves off its bespoke stack and onto the Cloudflare Workers "OS"
fork. The live instance is **https://os.myoplan.app**.

## What changes

- HQ's **schema** survives the move; HQ's **code** does not. Departments,
  projects, tasks, notes, agents, and grants keep their shape; the bespoke pages
  that rendered them are replaced by gadgets.
- Everything is built as a **gadget inside a workspace** rather than as a
  hand-rolled route. Each gadget owns its own Durable Object SQLite storage and
  exposes an RPC surface that both the browser UI and agents call.
- Gadgets are authored headlessly through the \`os-client\` CLI harness
  (\`pnpm os-client\`) — prod has no AI model configured, so code is written
  directly via \`code:write\` + \`code:merge\` rather than through the in-app agent.

## What has not changed yet

Until the data migration lands, **hq.owencairns.dev remains the system of
record** for notes, tasks, projects, and agent grants. Write new operational
data there, not here. This document flips when the migration completes.

## Gadget trio

| Gadget | Purpose |
|---|---|
| MyoPlan Tasks | work items, projects, and the attention queue |
| MyoPlan Memory | durable agent memory, wiki-linked |
| MyoPlan Docs | this store — long-form documents addressed by path |

See [company/agents](#) for how agents are expected to use them.`,
  },
  {
    path: "company/agents",
    title: "Operating guide: agents",
    tags: ["operations", "agents", "stub"],
    body: `# Operating guide: agents

> **Stub.** This is the skeleton of the agent operating guide; fill it in as the
> conventions settle.

## How agents connect

- **OAuth (coming).** Agents will authenticate to os.myoplan.app over OAuth and
  receive a scoped session, replacing today's hand-issued CLI tokens.
- Until then, agents drive the instance through the \`os-client\` harness with a
  \`username:token\` credential.

## What agents work with

Three first-party gadgets, each a workspace with its own RPC surface:

| Gadget | Use it for |
|---|---|
| **Tasks** | claim work, move status, log updates, read the attention queue |
| **Memory** | durable facts and decisions worth recalling across sessions |
| **Docs** | long-form written artifacts addressed by a stable path |

## The rule that matters

**Write outcomes back.** An agent that finishes a piece of work and leaves no
trace has done half the job. Close or update the task, record the decision in
Memory, and write the durable artifact into Docs under a path someone else would
guess.

## To fill in

- Grant model and scopes once OAuth lands
- Escalation / approval path for destructive operations
- Naming conventions for agent identities`,
  },
  {
    path: "readme",
    title: "MyoPlan Docs — what this is",
    tags: ["meta", "reference"],
    body: `# MyoPlan Docs

A path-first document store. Every document is identified by its **path** — a
slash-separated list of kebab-case segments — and folders are implicit: they
exist because documents underneath them exist.

    company/decisions/2026-08-23-migrate-hq-onto-cloudflare-os
    company/agents
    readme

Paths are normalized on every call, so \`write({ path: "Company/ Agents" })\`
and \`read("company/agents")\` address the same document.

## RPC surface

\`\`\`js
await docs.write({ path, title, body, tags })  // upsert -> { document, created }
await docs.read("company/agents")              // full record, or null
await docs.delete("company/agents")            // true if one was removed
await docs.list({ prefix, tag })               // summaries, sorted by path
await docs.search("migration")                 // ranked { path, title, excerpt, score }
await docs.move("old/path", "new/path")        // rename; returns the moved document
await docs.tree()                              // nested folder structure
await docs.tags()                              // every tag in use, with counts
await docs.stats()                             // counts for the UI
\`\`\`

\`subscribe(callback)\` exists for the UI: \`callback.update(event)\` fires on
every write, move, and delete so open browsers re-fetch.

## Conventions

- **Upsert, never duplicate.** \`write()\` on an existing path replaces title,
  body, and tags and bumps \`updatedAt\`; \`id\` and \`createdAt\` are preserved.
- **Paths are the index.** Prefer a path someone else would guess over a clever
  title. \`list({ prefix: "company/decisions" })\` is how a folder is read.
- **Dated decisions lead with the date**, \`YYYY-MM-DD-slug\`, so a folder sorts
  chronologically on path alone.
- Writes are serialized through a mutation queue so overlapping RPC calls can't
  interleave an upsert with its broadcast.`,
  },
];

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.subscribers = new Set();
    // RPC calls interleave at await points; serialize writes so upserts and the
    // broadcasts that follow them stay in a single consistent order.
    this.mutationQueue = Promise.resolve();

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id        TEXT PRIMARY KEY,
          path      TEXT NOT NULL UNIQUE,
          title     TEXT NOT NULL DEFAULT '',
          body      TEXT NOT NULL DEFAULT '',
          tags      TEXT NOT NULL DEFAULT '[]',
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        )
      `);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS documents_updated ON documents (updatedAt)`);

      const seeded = await ctx.storage.get("seeded:v1");
      if (!seeded) {
        const count = [...this.sql.exec(`SELECT COUNT(*) AS n FROM documents`)][0].n;
        if (count === 0) {
          const now = Date.now();
          for (const seed of SEEDS) this.writeRow(seed, now);
        }
        await ctx.storage.put("seeded:v1", true);
      }
    });
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  // --- internals ------------------------------------------------------------

  writeRow({ path, title, body, tags }, now) {
    const key = normalizePath(path);
    const tagList = normalizeTags(tags);
    const existing = [...this.sql.exec(`SELECT * FROM documents WHERE path = ?`, key)][0];
    const createdAt = existing ? existing.createdAt : now;
    const id = existing ? existing.id : crypto.randomUUID();
    const heading = String(title ?? "").trim() || (existing ? existing.title : "") || titleFromPath(key);

    this.sql.exec(
      `INSERT INTO documents (id, path, title, body, tags, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         title     = excluded.title,
         body      = excluded.body,
         tags      = excluded.tags,
         updatedAt = excluded.updatedAt`,
      id,
      key,
      heading,
      String(body ?? ""),
      JSON.stringify(tagList),
      createdAt,
      now,
    );

    const row = [...this.sql.exec(`SELECT * FROM documents WHERE path = ?`, key)][0];
    return { document: rowToDocument(row), created: !existing };
  }

  allRows() {
    return [...this.sql.exec(`SELECT * FROM documents ORDER BY path ASC`)].map(rowToDocument);
  }

  async broadcast(event) {
    for (const sub of [...this.subscribers]) {
      try {
        sub.update(event);
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  // --- agent-facing RPC surface ---------------------------------------------

  /**
   * Upsert a document by path. `title` defaults to the humanized last segment on
   * create, and to the existing title on update.
   * write({ path, title?, body, tags? }) -> { document, created }
   */
  write(args) {
    if (!args || typeof args !== "object") throw new Error("write() takes an object");
    return this.enqueueMutation(async () => {
      const result = this.writeRow(args, Date.now());
      await this.broadcast({ type: "changed", path: result.document.path });
      return result;
    });
  }

  /** Full record for one document, or null. */
  read(path) {
    const key = normalizePath(path);
    const row = [...this.sql.exec(`SELECT * FROM documents WHERE path = ?`, key)][0];
    return row ? rowToDocument(row) : null;
  }

  /** Delete a document. Returns true if one was removed. */
  delete(path) {
    const key = normalizePath(path);
    return this.enqueueMutation(async () => {
      const existing = [...this.sql.exec(`SELECT id FROM documents WHERE path = ?`, key)][0];
      if (!existing) return false;
      this.sql.exec(`DELETE FROM documents WHERE path = ?`, key);
      await this.broadcast({ type: "removed", path: key });
      return true;
    });
  }

  /** Alias for delete(), for callers in languages/tooling where `delete` is awkward. */
  remove(path) {
    return this.delete(path);
  }

  /**
   * Summaries sorted by path. list({ prefix?, tag? }) or list("company/decisions").
   * `prefix` matches whole segments: prefix "company" matches "company/agents"
   * and "company" itself, but never "companywide/x".
   */
  list(options) {
    let prefix = "";
    let tag = null;
    if (typeof options === "string") prefix = normalizePrefix(options);
    else if (options && typeof options === "object") {
      prefix = normalizePrefix(options.prefix);
      if (options.tag) tag = normalizeTags(options.tag)[0] || null;
    }
    let rows = this.allRows();
    if (prefix) rows = rows.filter((d) => d.path === prefix || d.path.startsWith(prefix + "/"));
    if (tag) rows = rows.filter((d) => d.tags.includes(tag));
    return rows.map(summarize);
  }

  /** Full records, for the UI and for bulk export. */
  listFull(options) {
    const paths = new Set(this.list(options).map((s) => s.path));
    return this.allRows().filter((d) => paths.has(d.path));
  }

  /**
   * Ranked search over path + title + body.
   * search(query) or search({ query, prefix?, tag?, limit? })
   * -> [{ path, title, tags, updatedAt, score, excerpt }, ...]
   */
  search(query) {
    let q = query;
    let options = {};
    let limit = 20;
    if (query && typeof query === "object") {
      q = query.query;
      options = { prefix: query.prefix, tag: query.tag };
      if (Number.isFinite(query.limit)) limit = Math.max(1, Math.min(200, query.limit));
    }
    const terms = String(q == null ? "" : q)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);

    const rows = this.listFull(options);
    if (terms.length === 0) {
      return rows.slice(0, limit).map((d) => ({ ...summarize(d), score: 0, excerpt: excerptFor(d.body, []) }));
    }

    const scored = [];
    for (const doc of rows) {
      const path = doc.path.toLowerCase();
      const last = path.split("/").pop();
      const title = doc.title.toLowerCase();
      const body = doc.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (last === term) score += 20;
        if (path.includes(term)) score += 8;
        if (title.includes(term)) score += 6;
        if (doc.tags.includes(term)) score += 5;
        score += Math.min(body.split(term).length - 1, 5);
      }
      if (score > 0) scored.push({ ...summarize(doc), score, excerpt: excerptFor(doc.body, terms) });
    }
    scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    return scored.slice(0, limit);
  }

  /**
   * Rename a document. Throws if `from` does not exist or `to` is already taken.
   * Returns the moved document.
   */
  move(from, to) {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    return this.enqueueMutation(async () => {
      const existing = [...this.sql.exec(`SELECT * FROM documents WHERE path = ?`, src)][0];
      if (!existing) throw new Error(`No document at '${src}'`);
      if (src === dst) return rowToDocument(existing);
      const clash = [...this.sql.exec(`SELECT id FROM documents WHERE path = ?`, dst)][0];
      if (clash) throw new Error(`A document already exists at '${dst}'`);
      this.sql.exec(`UPDATE documents SET path = ?, updatedAt = ? WHERE path = ?`, dst, Date.now(), src);
      const row = [...this.sql.exec(`SELECT * FROM documents WHERE path = ?`, dst)][0];
      await this.broadcast({ type: "moved", from: src, path: dst });
      return rowToDocument(row);
    });
  }

  /**
   * The implicit folder hierarchy derived from every path.
   * -> { name: "", path: "", folders: [...same shape], documents: [...summaries], count }
   * `count` is the total number of documents at or below that folder.
   */
  tree(options) {
    const root = { name: "", path: "", folders: [], documents: [], count: 0 };
    const folderAt = (segments) => {
      let node = root;
      const walked = [];
      for (const seg of segments) {
        walked.push(seg);
        let next = node.folders.find((f) => f.name === seg);
        if (!next) {
          next = { name: seg, path: walked.join("/"), folders: [], documents: [], count: 0 };
          node.folders.push(next);
        }
        node = next;
      }
      return node;
    };

    for (const doc of this.list(options)) {
      const segments = doc.path.split("/");
      const leaf = segments.pop();
      const parent = folderAt(segments);
      parent.documents.push(doc);
      // Bump counts along the whole chain, root included.
      let node = root;
      node.count += 1;
      for (const seg of segments) {
        node = node.folders.find((f) => f.name === seg);
        node.count += 1;
      }
      void leaf;
    }

    const sortNode = (node) => {
      node.folders.sort((a, b) => a.name.localeCompare(b.name));
      node.documents.sort((a, b) => a.path.localeCompare(b.path));
      node.folders.forEach(sortNode);
    };
    sortNode(root);
    return root;
  }

  /** Every tag in use, with a document count, most-used first. */
  tags() {
    const counts = new Map();
    for (const doc of this.allRows()) {
      for (const tag of doc.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** Small aggregate for headers and for agents sanity-checking a store. */
  stats() {
    const rows = this.allRows();
    const folders = new Set();
    for (const doc of rows) {
      const segments = doc.path.split("/");
      segments.pop();
      const walked = [];
      for (const seg of segments) {
        walked.push(seg);
        folders.add(walked.join("/"));
      }
    }
    return {
      documents: rows.length,
      folders: folders.size,
      tags: this.tags().length,
      updatedAt: rows.reduce((max, d) => Math.max(max, d.updatedAt), 0),
    };
  }

  /** Path normalization, exposed so agents can preview what a path will become. */
  normalize(path) {
    return normalizePath(path);
  }

  // --- backup / restore ------------------------------------------------------

  /**
   * exportAll() -> a complete, self-describing snapshot of this gadget's storage:
   *
   *   { gadget: "docs", schemaVersion, exportedAt, counts: {...}, data: { <table>: [...rows] } }
   *
   * Raw rows, not `rowToDocument()` shapes: `tags` stays the stored JSON string so a restore is a
   * byte-for-byte reinstatement rather than a re-derivation. Read-only.
   */
  async exportAll() {
    const data = {};
    const counts = {};
    for (const table of EXPORT_TABLES) {
      const rows = [...this.sql.exec(`SELECT ${table.columns.join(", ")} FROM ${table.name}`)];
      data[table.name] = rows;
      counts[table.name] = rows.length;
    }
    return {
      gadget: GADGET_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      counts,
      data,
    };
  }

  /**
   * importAll(snapshot, {mode}) -> {imported, skipped, mode}
   *
   * The restore half of exportAll(). `mode: "replace"` empties the tables first, so the result is
   * exactly the snapshot; `mode: "merge"` (the default) upserts by document `path`, leaving
   * documents the snapshot doesn't mention alone. Goes through the mutation queue like every
   * other write.
   */
  importAll(snapshot, options) {
    validateSnapshot(snapshot);
    const mode = options && options.mode === "replace" ? "replace" : "merge";
    return this.enqueueMutation(async () => {
      if (mode === "replace") {
        for (const table of [...EXPORT_TABLES].reverse()) this.sql.exec(`DELETE FROM ${table.name}`);
      }

      let imported = 0;
      let skipped = 0;
      for (const table of EXPORT_TABLES) {
        const incoming = snapshot.data[table.name];
        if (!Array.isArray(incoming)) continue;
        const placeholders = table.columns.map(() => "?").join(", ");
        const assignments = table.columns
          .filter((c) => c !== table.key && c !== "id")
          .map((c) => `${c} = excluded.${c}`)
          .join(", ");
        for (const row of incoming) {
          if (!row || typeof row !== "object" || row[table.key] == null) {
            skipped++;
            continue;
          }
          // A row whose `id` is already held by a *different* path would trip the PRIMARY KEY
          // constraint before the ON CONFLICT(path) clause could fire. Clear that stale row first.
          this.sql.exec(
            `DELETE FROM ${table.name} WHERE id = ? AND ${table.key} <> ?`,
            row.id,
            row[table.key],
          );
          const values = table.columns.map((c) => (row[c] === undefined ? null : row[c]));
          this.sql.exec(
            `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders})
             ON CONFLICT(${table.key}) DO UPDATE SET ${assignments}`,
            ...values,
          );
          imported++;
        }
      }

      await this.broadcast({ type: "changed" });
      return { imported, skipped, mode };
    });
  }

  // --- live updates for the browser UI --------------------------------------

  async subscribe(callback) {
    const dup = callback.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
    return true;
  }
}

/** Rejects anything that isn't a snapshot this gadget knows how to restore. */
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("importAll: snapshot must be an object.");
  }
  if (snapshot.gadget !== GADGET_NAME) {
    throw new Error(
      `importAll: snapshot is for gadget '${snapshot.gadget}', but this is '${GADGET_NAME}'.`,
    );
  }
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `importAll: unsupported schemaVersion ${JSON.stringify(snapshot.schemaVersion)} ` +
        `(this gadget understands ${SCHEMA_VERSION}).`,
    );
  }
  if (!snapshot.data || typeof snapshot.data !== "object") {
    throw new Error("importAll: snapshot.data is missing or not an object.");
  }
}
