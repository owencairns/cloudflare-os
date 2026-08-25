// MyoPlan Memory — agent-first knowledge/memory store.
//
// The RPC methods on `Gadget` are the product: agents call remember/recall/get/
// forget/list/related over the workspace's gadget stub. The browser UI in
// client.js is a thin reader/editor over the same surface.

import { DurableObject } from "cloudflare:workers";

const TYPES = ["user", "feedback", "project", "reference", "decision"];

// Backup/restore. `EXPORT_TABLES` is the full storage surface: every table, every column. The
// natural key is `name` (the slug), which is what `remember()` upserts on. Bump SCHEMA_VERSION
// only if the table/column shape changes.
const SCHEMA_VERSION = 1;
const GADGET_NAME = "memory";
const EXPORT_TABLES = [
  {
    name: "memories",
    key: "name",
    columns: ["id", "name", "description", "type", "body", "links", "createdAt", "updatedAt"],
  },
];

function slugify(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("name must contain at least one alphanumeric character");
  return slug.slice(0, 120);
}

function normalizeType(type) {
  const t = String(type || "").trim().toLowerCase();
  if (!TYPES.includes(t)) {
    throw new Error(`type must be one of: ${TYPES.join(", ")} (got ${JSON.stringify(type)})`);
  }
  return t;
}

function normalizeLinks(links) {
  if (links == null) return [];
  if (!Array.isArray(links)) throw new Error("links must be an array of memory names");
  const seen = [];
  for (const raw of links) {
    const slug = slugify(raw);
    if (!seen.includes(slug)) seen.push(slug);
  }
  return seen;
}

// Wiki-style [[links]] embedded in the body count as links too, so an agent can
// just write prose and get a graph for free.
function extractInlineLinks(body) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    try {
      const slug = slugify(m[1]);
      if (!out.includes(slug)) out.push(slug);
    } catch {
      // Ignore unslugifiable link text.
    }
  }
  return out;
}

function rowToMemory(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    body: row.body,
    links: JSON.parse(row.links || "[]"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function summarize(memory) {
  return {
    name: memory.name,
    description: memory.description,
    type: memory.type,
    links: memory.links,
    updatedAt: memory.updatedAt,
  };
}

const SEEDS = [
  {
    name: "myoplan-os-migration",
    type: "decision",
    description:
      "MyoPlan HQ is migrating onto the Cloudflare OS fork; os.myoplan.app is the live instance.",
    links: ["old-hq", "core-gadgets"],
    body: `# Decision: MyoPlan HQ migrates onto CF OS

**Decided:** 2026-08-23

HQ moves off its bespoke stack and onto the Cloudflare Workers "OS" fork. The
live instance is **https://os.myoplan.app**.

- HQ's *schema* survives the move; HQ's *code* does not.
- Everything is built as gadgets in workspaces rather than as bespoke pages.
- Until the data migration lands, [[old-hq]] stays the system of record.

See [[core-gadgets]] for the gadgets being stood up on the new instance.`,
  },
  {
    name: "core-gadgets",
    type: "project",
    description:
      "The first-party gadgets (tasks, memory, docs) being built on os.myoplan.app via the os-client harness.",
    links: ["myoplan-os-migration"],
    body: `# Project: core gadgets

The starter set of first-party gadgets on the new OS instance, all authored
headlessly through the \`os-client\` CLI harness (\`pnpm os-client\`) rather than
through the in-app agent — prod has no AI model configured, so code is written
directly via \`code:write\` + \`code:merge\`.

| Gadget | Purpose |
|---|---|
| Task tracker | work items and status |
| **MyoPlan Memory** | this gadget — durable agent memory |
| Docs | long-form notes and documents |

Context: [[myoplan-os-migration]].`,
  },
  {
    name: "old-hq",
    type: "reference",
    description:
      "hq.owencairns.dev remains the system of record until the data migration completes.",
    links: ["myoplan-os-migration"],
    body: `# Reference: old HQ

**https://hq.owencairns.dev** is the pre-migration HQ deployment.

It remains the **system of record** for notes, tasks, projects, and agent
grants until the data migration onto [[myoplan-os-migration]] completes. Write
new operational data there, not here, until that flips.`,
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
        CREATE TABLE IF NOT EXISTS memories (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          type        TEXT NOT NULL,
          body        TEXT NOT NULL DEFAULT '',
          links       TEXT NOT NULL DEFAULT '[]',
          createdAt   INTEGER NOT NULL,
          updatedAt   INTEGER NOT NULL
        )
      `);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS memories_type ON memories (type)`);

      const seeded = await ctx.storage.get("seeded:v1");
      if (!seeded) {
        const count = [...this.sql.exec(`SELECT COUNT(*) AS n FROM memories`)][0].n;
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

  writeRow({ name, description, type, body, links }, now) {
    const slug = slugify(name);
    const kind = normalizeType(type);
    const explicit = normalizeLinks(links);
    const merged = [...explicit];
    for (const inline of extractInlineLinks(body)) {
      if (!merged.includes(inline) && inline !== slug) merged.push(inline);
    }

    const existing = [...this.sql.exec(`SELECT * FROM memories WHERE name = ?`, slug)][0];
    const createdAt = existing ? existing.createdAt : now;
    const id = existing ? existing.id : crypto.randomUUID();

    this.sql.exec(
      `INSERT INTO memories (id, name, description, type, body, links, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         description = excluded.description,
         type        = excluded.type,
         body        = excluded.body,
         links       = excluded.links,
         updatedAt   = excluded.updatedAt`,
      id,
      slug,
      String(description ?? ""),
      kind,
      String(body ?? ""),
      JSON.stringify(merged),
      createdAt,
      now,
    );

    const row = [...this.sql.exec(`SELECT * FROM memories WHERE name = ?`, slug)][0];
    return { memory: rowToMemory(row), created: !existing };
  }

  allRows() {
    return [...this.sql.exec(`SELECT * FROM memories ORDER BY updatedAt DESC`)].map(rowToMemory);
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
   * Upsert a memory by name. Returns { memory, created }.
   * remember({ name, description, type, body, links? })
   */
  remember(args) {
    if (!args || typeof args !== "object") throw new Error("remember() takes an object");
    return this.enqueueMutation(async () => {
      const result = this.writeRow(args, Date.now());
      await this.broadcast({ type: "changed", name: result.memory.name });
      return result;
    });
  }

  /** Full record for one memory, or null. */
  get(name) {
    const slug = slugify(name);
    const row = [...this.sql.exec(`SELECT * FROM memories WHERE name = ?`, slug)][0];
    return row ? rowToMemory(row) : null;
  }

  /**
   * Ranked search over name + description + body. Returns summaries with a
   * relevance score and a matching excerpt — cheap enough for an agent to call
   * before deciding which memories to `get()` in full.
   * recall(query) or recall({ query, type?, limit? })
   */
  recall(query) {
    let q = query;
    let type = null;
    let limit = 10;
    if (query && typeof query === "object") {
      q = query.query;
      type = query.type ? normalizeType(query.type) : null;
      if (Number.isFinite(query.limit)) limit = Math.max(1, Math.min(100, query.limit));
    }
    const terms = String(q || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);

    let rows = this.allRows();
    if (type) rows = rows.filter((r) => r.type === type);
    if (terms.length === 0) return rows.slice(0, limit).map((m) => ({ ...summarize(m), score: 0, excerpt: "" }));

    const scored = [];
    for (const memory of rows) {
      const name = memory.name.toLowerCase();
      const description = memory.description.toLowerCase();
      const body = memory.body.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 20;
        if (name.includes(term)) score += 8;
        if (description.includes(term)) score += 4;
        const hits = body.split(term).length - 1;
        score += Math.min(hits, 5);
      }
      if (score > 0) scored.push({ ...summarize(memory), score, excerpt: excerptFor(memory.body, terms) });
    }
    scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return scored.slice(0, limit);
  }

  /** Delete a memory. Returns true if one was removed. */
  forget(name) {
    const slug = slugify(name);
    return this.enqueueMutation(async () => {
      const existing = [...this.sql.exec(`SELECT id FROM memories WHERE name = ?`, slug)][0];
      if (!existing) return false;
      this.sql.exec(`DELETE FROM memories WHERE name = ?`, slug);
      await this.broadcast({ type: "removed", name: slug });
      return true;
    });
  }

  /** Summaries of every memory, newest first. list({ type? }) or list("project"). */
  list(options) {
    let type = null;
    if (typeof options === "string") type = normalizeType(options);
    else if (options && options.type) type = normalizeType(options.type);
    let rows = this.allRows();
    if (type) rows = rows.filter((r) => r.type === type);
    return rows.map(summarize);
  }

  /** Full records, for the UI and for bulk export. */
  listFull() {
    return this.allRows();
  }

  /**
   * Follow links in both directions.
   * Returns { name, outgoing: [...summaries], incoming: [...summaries], missing: [names] }
   * where `missing` are outgoing link targets that have no memory yet.
   */
  related(name) {
    const slug = slugify(name);
    const rows = this.allRows();
    const self = rows.find((r) => r.name === slug);
    if (!self) throw new Error(`No memory named '${slug}'`);
    const byName = new Map(rows.map((r) => [r.name, r]));

    const outgoing = [];
    const missing = [];
    for (const target of self.links) {
      const hit = byName.get(target);
      if (hit) outgoing.push(summarize(hit));
      else missing.push(target);
    }
    const incoming = rows
      .filter((r) => r.name !== slug && r.links.includes(slug))
      .map(summarize);
    return { name: slug, outgoing, incoming, missing };
  }

  /** The valid `type` values, for UIs and for agents building forms. */
  types() {
    return [...TYPES];
  }

  // --- backup / restore ------------------------------------------------------

  /**
   * exportAll() -> a complete, self-describing snapshot of this gadget's storage:
   *
   *   { gadget: "memory", schemaVersion, exportedAt, counts: {...}, data: { <table>: [...rows] } }
   *
   * Raw rows, not `rowToMemory()` shapes: `links` stays the stored JSON string so a restore is a
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
   * exactly the snapshot; `mode: "merge"` (the default) upserts by memory `name`, leaving memories
   * the snapshot doesn't mention alone. Goes through the mutation queue like every other write.
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
          // A row whose `id` is already held by a *different* name would trip the PRIMARY KEY
          // constraint before the ON CONFLICT(name) clause could fire. Clear that stale row first.
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

function excerptFor(body, terms) {
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return body.slice(0, 160).trim();
  const start = Math.max(0, at - 60);
  const slice = body.slice(start, start + 200).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (start + 200 < body.length ? "…" : "");
}
