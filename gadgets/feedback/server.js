// MyoPlan Feedback — durable triage inbox and agent ingestion API.
import { DurableObject } from "cloudflare:workers";

const STATUSES = ["new", "reviewing", "planned", "resolved", "closed"];
const CATEGORIES = ["bug", "idea", "question", "praise", "other"];
const SEVERITIES = ["none", "low", "medium", "high", "critical"];
const LIMITS = { body: 20000, note: 10000, text: 200, tags: 32, metadata: 8192 };
const STATUS_RANK = { new: 0, reviewing: 1, planned: 2, resolved: 3, closed: 4 };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
const FEEDBACK_COLUMNS = [
  "id",
  "externalId",
  "title",
  "body",
  "status",
  "category",
  "severity",
  "assignee",
  "tags",
  "source",
  "surface",
  "appVersion",
  "appBuild",
  "device",
  "os",
  "route",
  "inputMode",
  "traceId",
  "sessionId",
  "reporter",
  "metadata",
  "linkedTaskId",
  "linkedTaskTitle",
  "linkedTaskUrl",
  "createdAt",
  "updatedAt",
  "resolvedAt",
];
const TABLES = [
  { name: "feedback", key: "id", columns: FEEDBACK_COLUMNS },
  {
    name: "notes",
    key: "id",
    columns: ["id", "feedbackId", "kind", "body", "author", "createdAt"],
  },
  { name: "links", key: "id", columns: ["id", "kind", "sourceId", "targetId", "createdAt"] },
];
const REQUIRED_IMPORT_COLUMNS = {
  feedback: [
    "id",
    "body",
    "status",
    "category",
    "severity",
    "tags",
    "reporter",
    "metadata",
    "createdAt",
    "updatedAt",
  ],
  notes: ["id", "feedbackId", "kind", "body", "createdAt"],
  links: ["id", "kind", "sourceId", "targetId", "createdAt"],
};
const textFields = [
  "surface",
  "appVersion",
  "appBuild",
  "device",
  "os",
  "route",
  "inputMode",
  "traceId",
  "sessionId",
  "externalId",
];

const now = () => new Date().toISOString();
const id = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const clean = (value) => (value == null ? null : String(value).trim() || null);
function bounded(value, name, limit = LIMITS.text) {
  const result = clean(value);
  if (result && result.length > limit) throw new Error(`${name} exceeds maximum length ${limit}.`);
  return result;
}
function enumValue(value, name, allowed, fallback) {
  if (value == null) return fallback;
  const result = String(value);
  if (!allowed.includes(result)) throw new Error(`Invalid ${name}: '${result}'.`);
  return result;
}
function jsonObject(value, name) {
  if (value == null) return {};
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${name} must be a plain object.`);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`${name} must be JSON serializable.`);
  }
  if (encoded.length > LIMITS.metadata)
    throw new Error(`${name} exceeds maximum length ${LIMITS.metadata}.`);
  return value;
}
function tags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("tags must be an array.");
  if (value.length > LIMITS.tags)
    throw new Error(`tags may contain at most ${LIMITS.tags} entries.`);
  return [...new Set(value.map((tag) => bounded(tag, "tag")).filter(Boolean))];
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.subscribers = new Set();
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if (env.seedSamples !== false) await this.seed();
    });
  }
  migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS feedback (${FEEDBACK_COLUMNS.map((c) => `${c} TEXT${["id", "body", "status", "category", "severity", "tags", "reporter", "metadata", "createdAt", "updatedAt"].includes(c) ? " NOT NULL" : ""}`).join(", ")}, PRIMARY KEY (id))`,
    );
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS feedback_external ON feedback(externalId) WHERE externalId IS NOT NULL",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, feedbackId TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, author TEXT, createdAt TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, kind TEXT NOT NULL, sourceId TEXT NOT NULL, targetId TEXT NOT NULL, createdAt TEXT NOT NULL)",
    );
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS links_unique ON links(kind, sourceId, targetId)");
  }
  rows(query, ...args) {
    return this.ctx.storage.sql.exec(query, ...args).toArray();
  }
  async seed() {
    if (await this.ctx.storage.get("seeded")) return;
    await this.ctx.storage.put("seeded", true);
    if (!this.rows("SELECT id FROM feedback LIMIT 1").length)
      await this.submit({
        body: "The workout timer skipped a rep during an interval.",
        category: "bug",
        severity: "high",
        source: "ios",
        tags: ["alpha", "timer"],
      });
  }
  hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      tags: JSON.parse(row.tags || "[]"),
      reporter: JSON.parse(row.reporter || "{}"),
      metadata: JSON.parse(row.metadata || "{}"),
    };
  }
  async subscribe(callback) {
    const dup = callback.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
    return { ok: true };
  }
  broadcast() {
    for (const sub of this.subscribers)
      try {
        sub.changed();
      } catch {
        this.subscribers.delete(sub);
      }
  }
  require(idValue) {
    const found = this.rows("SELECT * FROM feedback WHERE id = ?", String(idValue))[0];
    if (!found) throw new Error(`No feedback '${idValue}' found.`);
    return this.hydrate(found);
  }

  async submit(args = {}) {
    const body = bounded(args.body, "body", LIMITS.body);
    if (!body) throw new Error("submit: body is required.");
    const externalId = bounded(args.externalId, "externalId");
    if (externalId) {
      const old = this.rows("SELECT * FROM feedback WHERE externalId = ?", externalId)[0];
      if (old) return this.hydrate(old);
    }
    const category = enumValue(args.category, "category", CATEGORIES, "other");
    const severity = enumValue(args.severity, "severity", SEVERITIES, "none");
    const status = enumValue(args.status, "status", STATUSES, "new");
    const tagList = tags(args.tags);
    const metadata = jsonObject(args.metadata, "metadata");
    const reporter = jsonObject(args.reporter, "reporter");
    const t = now();
    const row = {
      id: id("fbk"),
      externalId,
      title: bounded(args.title, "title"),
      body,
      status,
      category,
      severity,
      assignee: null,
      tags: JSON.stringify(tagList),
      source: bounded(args.source, "source"),
      surface: null,
      appVersion: null,
      appBuild: null,
      device: null,
      os: null,
      route: null,
      inputMode: null,
      traceId: null,
      sessionId: null,
      reporter: JSON.stringify(reporter),
      metadata: JSON.stringify(metadata),
      linkedTaskId: null,
      linkedTaskTitle: null,
      linkedTaskUrl: null,
      createdAt: t,
      updatedAt: t,
      resolvedAt: ["resolved", "closed"].includes(status) ? t : null,
    };
    for (const field of textFields)
      if (field !== "externalId") row[field] = bounded(args[field], field);
    this.ctx.storage.sql.exec(
      `INSERT INTO feedback (${FEEDBACK_COLUMNS.join(",")}) VALUES (${FEEDBACK_COLUMNS.map(() => "?").join(",")})`,
      ...FEEDBACK_COLUMNS.map((c) => row[c]),
    );
    this.broadcast();
    return this.get(row.id);
  }
  async get(feedbackId) {
    return this.hydrate(this.rows("SELECT * FROM feedback WHERE id = ?", String(feedbackId))[0]);
  }
  async list(filters = {}) {
    let all = this.rows("SELECT * FROM feedback").map((r) => this.hydrate(r));
    for (const field of ["category", "severity", "assignee", "source"]) {
      const v = clean(filters[field]);
      if (v) all = all.filter((r) => r[field] === v);
    }
    const status = clean(filters.status);
    if (status === "open") all = all.filter((r) => !["resolved", "closed"].includes(r.status));
    else if (status) all = all.filter((r) => r.status === status);
    const tag = clean(filters.tag);
    if (tag) all = all.filter((r) => r.tags.includes(tag));
    const search = clean(filters.search)?.toLowerCase();
    if (search)
      all = all.filter((r) => `${r.title || ""} ${r.body}`.toLowerCase().includes(search));
    if (filters.includeDuplicates === false) {
      const duplicateIds = new Set(
        this.rows("SELECT sourceId FROM links WHERE kind = 'duplicate'").map((r) => r.sourceId),
      );
      all = all.filter((r) => !duplicateIds.has(r.id));
    }
    const sort = filters.sort || "triage";
    all.sort(
      sort === "updated"
        ? (a, b) => b.updatedAt.localeCompare(a.updatedAt)
        : sort === "created"
          ? (a, b) => b.createdAt.localeCompare(a.createdAt)
          : (a, b) =>
              STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
              SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
              b.createdAt.localeCompare(a.createdAt) ||
              b.id.localeCompare(a.id),
    );
    return all;
  }
  async stats() {
    const result = {
      total: 0,
      open: 0,
      byStatus: Object.fromEntries(STATUSES.map((x) => [x, 0])),
      byCategory: Object.fromEntries(CATEGORIES.map((x) => [x, 0])),
      bySeverity: Object.fromEntries(SEVERITIES.map((x) => [x, 0])),
    };
    for (const r of await this.list({})) {
      result.total++;
      if (!["resolved", "closed"].includes(r.status)) result.open++;
      result.byStatus[r.status]++;
      result.byCategory[r.category]++;
      result.bySeverity[r.severity]++;
    }
    return result;
  }
  async snapshot(filters = {}) {
    return {
      feedback: await this.list(filters),
      counts: await this.stats(),
      assignees: this.rows(
        "SELECT DISTINCT assignee FROM feedback WHERE assignee IS NOT NULL ORDER BY assignee",
      ).map((r) => r.assignee),
      tags: [...new Set((await this.list({})).flatMap((r) => r.tags))].toSorted(),
    };
  }
  async update(feedbackId, patch = {}) {
    const old = this.require(feedbackId);
    const next = { ...old };
    for (const [field, allowed] of [
      ["status", STATUSES],
      ["category", CATEGORIES],
      ["severity", SEVERITIES],
    ])
      if (patch[field] !== undefined) next[field] = enumValue(patch[field], field, allowed);
    if (patch.assignee !== undefined) next.assignee = bounded(patch.assignee, "assignee");
    if (patch.title !== undefined) next.title = bounded(patch.title, "title");
    if (patch.tags !== undefined) next.tags = tags(patch.tags);
    const t = now();
    next.updatedAt = t;
    next.resolvedAt = ["resolved", "closed"].includes(next.status) ? old.resolvedAt || t : null;
    this.ctx.storage.sql.exec(
      "UPDATE feedback SET title=?, status=?, category=?, severity=?, assignee=?, tags=?, updatedAt=?, resolvedAt=? WHERE id=?",
      next.title,
      next.status,
      next.category,
      next.severity,
      next.assignee,
      JSON.stringify(next.tags),
      t,
      next.resolvedAt,
      old.id,
    );
    if (next.status !== old.status)
      this.addEvent(old.id, `Status changed from ${old.status} to ${next.status}.`, t);
    this.broadcast();
    return this.get(old.id);
  }
  addEvent(feedbackId, body, createdAt = now()) {
    this.ctx.storage.sql.exec(
      "INSERT INTO notes (id,feedbackId,kind,body,author,createdAt) VALUES (?,?,?,?,?,?)",
      id("nte"),
      feedbackId,
      "event",
      body,
      null,
      createdAt,
    );
  }
  async addNote(args = {}) {
    const feedbackId = String(args.feedbackId || "");
    this.require(feedbackId);
    const body = bounded(args.body, "body", LIMITS.note);
    if (!body) throw new Error("addNote: body is required.");
    const noteId = id("nte"),
      t = now();
    this.ctx.storage.sql.exec(
      "INSERT INTO notes VALUES (?,?,?,?,?,?)",
      noteId,
      feedbackId,
      "note",
      body,
      bounded(args.author, "author"),
      t,
    );
    this.ctx.storage.sql.exec("UPDATE feedback SET updatedAt=? WHERE id=?", t, feedbackId);
    this.broadcast();
    return this.rows("SELECT * FROM notes WHERE id=?", noteId)[0];
  }
  async listNotes(feedbackId) {
    this.require(feedbackId);
    return this.rows(
      "SELECT * FROM notes WHERE feedbackId=? ORDER BY createdAt,id",
      String(feedbackId),
    );
  }
  async deleteNote(noteId) {
    const note = this.rows("SELECT kind FROM notes WHERE id=?", String(noteId))[0];
    if (!note) throw new Error(`No note '${noteId}' found.`);
    if (note.kind === "event")
      throw new Error("Lifecycle events are immutable and cannot be deleted.");
    this.ctx.storage.sql.exec("DELETE FROM notes WHERE id=? AND kind='note'", String(noteId));
    this.broadcast();
    return { deleted: String(noteId) };
  }
  async markDuplicate(feedbackId, canonicalId) {
    if (String(feedbackId) === String(canonicalId))
      throw new Error("Feedback cannot duplicate itself.");
    this.require(feedbackId);
    this.require(canonicalId);
    this.ctx.storage.sql.exec(
      "DELETE FROM links WHERE kind='duplicate' AND sourceId=?",
      String(feedbackId),
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO links VALUES (?,?,?,?,?)",
      id("lnk"),
      "duplicate",
      String(feedbackId),
      String(canonicalId),
      now(),
    );
    this.broadcast();
    return this.detail(feedbackId);
  }
  async clearDuplicate(feedbackId) {
    this.require(feedbackId);
    this.ctx.storage.sql.exec(
      "DELETE FROM links WHERE kind='duplicate' AND sourceId=?",
      String(feedbackId),
    );
    this.broadcast();
    return this.detail(feedbackId);
  }
  async relate(a, b) {
    if (String(a) === String(b)) throw new Error("Feedback cannot relate to itself.");
    this.require(a);
    this.require(b);
    const [source, target] = [String(a), String(b)].toSorted();
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO links VALUES (?,?,?,?,?)",
      id("lnk"),
      "related",
      source,
      target,
      now(),
    );
    this.broadcast();
    return { ok: true };
  }
  async unrelate(a, b) {
    const [source, target] = [String(a), String(b)].toSorted();
    this.ctx.storage.sql.exec(
      "DELETE FROM links WHERE kind='related' AND sourceId=? AND targetId=?",
      source,
      target,
    );
    this.broadcast();
    return { ok: true };
  }
  async detail(feedbackId) {
    const feedback = this.require(feedbackId);
    const dup = this.rows(
      "SELECT targetId FROM links WHERE kind='duplicate' AND sourceId=?",
      feedback.id,
    )[0];
    const duplicates = this.rows(
      "SELECT sourceId FROM links WHERE kind='duplicate' AND targetId=?",
      feedback.id,
    ).map((r) => this.require(r.sourceId));
    const related = this.rows(
      "SELECT sourceId,targetId FROM links WHERE kind='related' AND (sourceId=? OR targetId=?)",
      feedback.id,
      feedback.id,
    ).map((r) => this.require(r.sourceId === feedback.id ? r.targetId : r.sourceId));
    return {
      ...feedback,
      duplicateOf: dup ? this.require(dup.targetId) : null,
      duplicates,
      related,
      notes: await this.listNotes(feedback.id),
    };
  }
  async linkTask(feedbackId, task = {}) {
    const old = this.require(feedbackId);
    const taskId = bounded(task.taskId, "taskId");
    if (!taskId) throw new Error("linkTask: taskId is required.");
    this.ctx.storage.sql.exec(
      "UPDATE feedback SET linkedTaskId=?,linkedTaskTitle=?,linkedTaskUrl=?,updatedAt=? WHERE id=?",
      taskId,
      bounded(task.taskTitle, "taskTitle"),
      bounded(task.taskUrl, "taskUrl"),
      now(),
      old.id,
    );
    this.addEvent(old.id, `Linked to task ${taskId}.`);
    this.broadcast();
    return this.get(old.id);
  }
  async unlinkTask(feedbackId) {
    const old = this.require(feedbackId);
    this.ctx.storage.sql.exec(
      "UPDATE feedback SET linkedTaskId=NULL,linkedTaskTitle=NULL,linkedTaskUrl=NULL,updatedAt=? WHERE id=?",
      now(),
      old.id,
    );
    this.broadcast();
    return this.get(old.id);
  }
  async promoteToTask(feedbackId, task) {
    await this.linkTask(feedbackId, task);
    const result = await this.update(feedbackId, { status: "planned" });
    this.addEvent(String(feedbackId), `Promoted to task ${result.linkedTaskId}.`);
    return result;
  }
  async describeSchema() {
    return { statuses: STATUSES, categories: CATEGORIES, severities: SEVERITIES, limits: LIMITS };
  }
  async exportAll() {
    const data = {},
      counts = {};
    for (const table of TABLES) {
      data[table.name] = this.rows(
        `SELECT ${table.columns.join(",")} FROM ${table.name} ORDER BY ${table.key}`,
      );
      counts[table.name] = data[table.name].length;
    }
    return { gadget: "feedback", schemaVersion: 1, exportedAt: now(), counts, data };
  }
  async importAll(snapshot, options = {}) {
    if (!snapshot || snapshot.gadget !== "feedback")
      throw new Error(`Snapshot is for '${snapshot?.gadget}', not feedback.`);
    if (snapshot.schemaVersion !== 1)
      throw new Error(`Unsupported schemaVersion ${snapshot.schemaVersion}.`);
    if (!snapshot.data || typeof snapshot.data !== "object")
      throw new Error("Snapshot data is required.");
    const mode = options.mode || "merge";
    if (!["merge", "replace"].includes(mode)) throw new Error("mode must be merge or replace.");

    // Validate and normalize the complete snapshot before the first write. Durable Object storage
    // calls are sync here, but an invalid late row must never leave a replace restore half-applied.
    const validated = {};
    for (const table of TABLES) {
      const rows = snapshot.data[table.name] || [];
      if (!Array.isArray(rows)) throw new Error(`data.${table.name} must be an array.`);
      const seenIds = new Set();
      validated[table.name] = rows.map((row, index) => {
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new Error(`data.${table.name}[${index}] must be an object.`);
        for (const column of REQUIRED_IMPORT_COLUMNS[table.name])
          if (row[column] === null || row[column] === undefined)
            throw new Error(`data.${table.name}[${index}].${column} is required.`);
        if (seenIds.has(row.id))
          throw new Error(`data.${table.name} contains duplicate id '${row.id}'.`);
        seenIds.add(row.id);
        return Object.fromEntries(table.columns.map((column) => [column, row[column] ?? null]));
      });
    }

    const externalOwners = new Map();
    for (const row of validated.feedback) {
      if (!row.externalId) continue;
      const snapshotOwner = externalOwners.get(row.externalId);
      if (snapshotOwner && snapshotOwner !== row.id)
        throw new Error(`externalId conflict: '${row.externalId}' belongs to multiple rows.`);
      externalOwners.set(row.externalId, row.id);
      if (mode === "merge") {
        const existing = this.rows("SELECT id FROM feedback WHERE externalId=?", row.externalId)[0];
        if (existing && existing.id !== row.id)
          throw new Error(`externalId conflict: '${row.externalId}' belongs to '${existing.id}'.`);
      }
    }

    if (mode === "replace")
      for (const table of TABLES.toReversed())
        this.ctx.storage.sql.exec(`DELETE FROM ${table.name}`);
    let imported = 0;
    for (const table of TABLES) {
      for (const row of validated[table.name]) {
        const cols = table.columns;
        const updates = cols
          .filter((column) => column !== table.key)
          .map((column) => `${column}=excluded.${column}`)
          .join(",");
        this.ctx.storage.sql.exec(
          `INSERT INTO ${table.name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT(${table.key}) DO UPDATE SET ${updates}`,
          ...cols.map((column) => row[column]),
        );
        imported++;
      }
    }
    this.broadcast();
    return { imported, skipped: 0, mode };
  }
}
