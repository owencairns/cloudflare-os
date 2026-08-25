// MyoPlan Tasks -- server half.
//
// A port of the MyoPlan HQ task model onto a Gadget Durable Object. All state lives in the DO's
// SQLite storage; the RPC methods below are the gadget's public API, called both by client.js and
// by agents holding a stub to this object.

import { DurableObject } from "cloudflare:workers";

const STATUSES = ["todo", "in_progress", "blocked", "done"];
const PRIORITIES = ["low", "medium", "high", "urgent"];
const PROJECT_STATUSES = ["active", "paused", "done", "archived"];

// Attention ordering: what should a human (or agent) look at first.
const STATUS_RANK = { blocked: 0, in_progress: 1, todo: 2, done: 3 };
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

// Backup/restore. `EXPORT_TABLES` is the full storage surface: every table, every column, in a
// dependency-safe order (parents first, so a `replace` import can insert straight down the list
// and delete straight up it). Bump SCHEMA_VERSION only if the table/column shape changes.
const SCHEMA_VERSION = 1;
const GADGET_NAME = "tasks";
const EXPORT_TABLES = [
  { name: "projects", key: "id", columns: ["id", "title", "status", "createdAt", "updatedAt"] },
  {
    name: "tasks",
    key: "id",
    columns: [
      "id", "title", "description", "status", "priority", "assignee", "project", "dueDate",
      "createdAt", "updatedAt", "completedAt",
    ],
  },
  { name: "updates", key: "id", columns: ["id", "taskId", "body", "author", "createdAt"] },
];

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function str(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function optStr(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function oneOf(value, allowed, fallback) {
  const s = value === undefined || value === null ? "" : String(value);
  return allowed.includes(s) ? s : fallback;
}

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new Set();
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.seedIfEmpty();
    });
  }

  // -------------------------------------------------------------------------------------------
  // schema
  // -------------------------------------------------------------------------------------------

  migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee TEXT,
      project TEXT,
      dueDate TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      completedAt TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS updates (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      body TEXT NOT NULL,
      author TEXT,
      createdAt TEXT NOT NULL
    )`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_updates_task ON updates (taskId)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)`);
  }

  rows(query, ...bindings) {
    return this.ctx.storage.sql.exec(query, ...bindings).toArray();
  }

  // -------------------------------------------------------------------------------------------
  // seed
  // -------------------------------------------------------------------------------------------

  async seedIfEmpty() {
    // Guarded by a one-shot flag, not by row count: emptying the tracker on purpose must not
    // resurrect the samples the next time the Durable Object wakes.
    if (await this.ctx.storage.get("seeded")) return;
    await this.ctx.storage.put("seeded", true);
    const [{ n }] = this.rows(`SELECT COUNT(*) AS n FROM tasks`);
    if (n > 0) return;

    const t = nowIso();
    const projectId = newId("prj");
    this.ctx.storage.sql.exec(
      `INSERT INTO projects (id, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
      projectId, "Alpha Launch", "active", t, t,
    );

    const day = 86400000;
    const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
    const samples = [
      {
        title: "TestFlight build rejected by App Store Connect",
        description: "Build 6 upload failed export compliance. Blocked until the encryption declaration is added to Info.plist.",
        status: "blocked",
        priority: "urgent",
        assignee: "owen",
        dueDate: iso(1),
      },
      {
        title: "Settings parity: address search on the practice profile",
        description: "Wire AddressSearchService into the setup wizard and settings so iOS matches web.",
        status: "in_progress",
        priority: "high",
        assignee: "owen",
        dueDate: iso(3),
      },
      {
        title: "Consent gate copy review",
        description: "Legal wording for ConsentGateView before alpha testers see it.",
        status: "todo",
        priority: "medium",
        assignee: "gina",
        dueDate: iso(7),
      },
      {
        title: "Ship inline feedback widget",
        description: "Alpha feedback sheet on web and iOS, filed into HQ.",
        status: "done",
        priority: "high",
        assignee: "owen",
        dueDate: iso(-2),
      },
    ];

    for (const sample of samples) {
      const id = newId("tsk");
      this.ctx.storage.sql.exec(
        `INSERT INTO tasks (id, title, description, status, priority, assignee, project, dueDate,
                            createdAt, updatedAt, completedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, sample.title, sample.description, sample.status, sample.priority, sample.assignee,
        projectId, sample.dueDate, t, t, sample.status === "done" ? t : null,
      );
      if (sample.status === "blocked") {
        this.ctx.storage.sql.exec(
          `INSERT INTO updates (id, taskId, body, author, createdAt) VALUES (?, ?, ?, ?, ?)`,
          newId("upd"), id, "Waiting on the compliance declaration before re-upload.", "owen", t,
        );
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // subscriptions (server -> client push)
  // -------------------------------------------------------------------------------------------

  /** Subscribe to change notifications. `callback.changed()` fires whenever any data mutates. */
  async subscribe(callback) {
    const dup = callback.dup();
    this.subscribers.add(dup);
    dup.onRpcBroken(() => this.subscribers.delete(dup));
    return { ok: true };
  }

  broadcast() {
    for (const sub of [...this.subscribers]) {
      try {
        sub.changed();
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // projects
  // -------------------------------------------------------------------------------------------

  /** createProject({title, status?}) -> project */
  async createProject(args = {}) {
    const title = str(args.title).trim();
    if (!title) throw new Error("createProject: `title` is required.");
    const t = nowIso();
    const id = newId("prj");
    this.ctx.storage.sql.exec(
      `INSERT INTO projects (id, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
      id, title, oneOf(args.status, PROJECT_STATUSES, "active"), t, t,
    );
    this.broadcast();
    return this.getProject(id);
  }

  /** listProjects({status?}) -> project[] */
  async listProjects(filters = {}) {
    const status = optStr(filters.status);
    const all = this.rows(`SELECT * FROM projects ORDER BY createdAt ASC`);
    const projects = status ? all.filter((p) => p.status === status) : all;
    const counts = this.rows(
      `SELECT project, status, COUNT(*) AS n FROM tasks WHERE project IS NOT NULL GROUP BY project, status`,
    );
    return projects.map((p) => {
      const mine = counts.filter((c) => c.project === p.id);
      const total = mine.reduce((sum, c) => sum + c.n, 0);
      const done = mine.filter((c) => c.status === "done").reduce((sum, c) => sum + c.n, 0);
      return { ...p, taskCount: total, openCount: total - done };
    });
  }

  /** getProject(id) -> project | null */
  async getProject(id) {
    const found = this.rows(`SELECT * FROM projects WHERE id = ?`, str(id));
    return found[0] ?? null;
  }

  /** updateProject(id, {title?, status?}) -> project */
  async updateProject(id, patch = {}) {
    const existing = await this.getProject(id);
    if (!existing) throw new Error(`updateProject: no project '${id}'.`);
    const title = patch.title === undefined ? existing.title : str(patch.title).trim() || existing.title;
    const status = patch.status === undefined ? existing.status : oneOf(patch.status, PROJECT_STATUSES, existing.status);
    this.ctx.storage.sql.exec(
      `UPDATE projects SET title = ?, status = ?, updatedAt = ? WHERE id = ?`,
      title, status, nowIso(), existing.id,
    );
    this.broadcast();
    return this.getProject(existing.id);
  }

  // -------------------------------------------------------------------------------------------
  // tasks
  // -------------------------------------------------------------------------------------------

  /**
   * createTask({title, description?, status?, priority?, assignee?, project?, dueDate?}) -> task
   * `project` is a project id (see listProjects). `dueDate` is an ISO date or datetime string.
   */
  async createTask(args = {}) {
    const title = str(args.title).trim();
    if (!title) throw new Error("createTask: `title` is required.");
    const t = nowIso();
    const id = newId("tsk");
    const status = oneOf(args.status, STATUSES, "todo");
    this.ctx.storage.sql.exec(
      `INSERT INTO tasks (id, title, description, status, priority, assignee, project, dueDate,
                          createdAt, updatedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, title, str(args.description), status, oneOf(args.priority, PRIORITIES, "medium"),
      optStr(args.assignee), optStr(args.project), optStr(args.dueDate), t, t,
      status === "done" ? t : null,
    );
    this.broadcast();
    return this.getTask(id);
  }

  /** getTask(id) -> task | null */
  async getTask(id) {
    const found = this.rows(`SELECT * FROM tasks WHERE id = ?`, str(id));
    return found[0] ?? null;
  }

  /**
   * updateTask(id, patch) -> task
   * patch may contain any of: title, description, status, priority, assignee, project, dueDate.
   * Setting status to "done" stamps completedAt; moving off "done" clears it.
   * assignee / project / dueDate accept null or "" to clear.
   */
  async updateTask(id, patch = {}) {
    const existing = await this.getTask(id);
    if (!existing) throw new Error(`updateTask: no task '${id}'.`);

    const next = {
      title: patch.title === undefined ? existing.title : str(patch.title).trim() || existing.title,
      description: patch.description === undefined ? existing.description : str(patch.description),
      status: patch.status === undefined ? existing.status : oneOf(patch.status, STATUSES, existing.status),
      priority: patch.priority === undefined ? existing.priority : oneOf(patch.priority, PRIORITIES, existing.priority),
      assignee: patch.assignee === undefined ? existing.assignee : optStr(patch.assignee),
      project: patch.project === undefined ? existing.project : optStr(patch.project),
      dueDate: patch.dueDate === undefined ? existing.dueDate : optStr(patch.dueDate),
    };

    const t = nowIso();
    let completedAt = existing.completedAt;
    if (next.status === "done" && existing.status !== "done") completedAt = t;
    if (next.status !== "done") completedAt = null;

    this.ctx.storage.sql.exec(
      `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee = ?,
                        project = ?, dueDate = ?, updatedAt = ?, completedAt = ? WHERE id = ?`,
      next.title, next.description, next.status, next.priority, next.assignee, next.project,
      next.dueDate, t, completedAt, existing.id,
    );
    this.broadcast();
    return this.getTask(existing.id);
  }

  /** completeTask(id) -> task. Convenience for updateTask(id, {status: "done"}). */
  async completeTask(id) {
    return this.updateTask(id, { status: "done" });
  }

  /** reopenTask(id, status?) -> task. Moves a done task back to an open band (default "todo"). */
  async reopenTask(id, status = "todo") {
    return this.updateTask(id, { status: oneOf(status, ["todo", "in_progress", "blocked"], "todo") });
  }

  /** deleteTask(id) -> {deleted}. Also deletes the task's updates. */
  async deleteTask(id) {
    const taskId = str(id);
    this.ctx.storage.sql.exec(`DELETE FROM updates WHERE taskId = ?`, taskId);
    this.ctx.storage.sql.exec(`DELETE FROM tasks WHERE id = ?`, taskId);
    this.broadcast();
    return { deleted: taskId };
  }

  /**
   * listTasks(filters) -> task[]
   *
   * filters: {status?, project?, assignee?, search?, includeDone?, sort?}
   *   status      one of todo|in_progress|blocked|done, or "open" for everything but done.
   *   project     project id.
   *   assignee    exact assignee match.
   *   search      case-insensitive substring over title + description.
   *   includeDone default true; set false to drop completed tasks regardless of `status`.
   *   sort        "attention" (default) | "created" | "updated" | "due".
   *
   * "attention" order: blocked, then in_progress, then todo, then done; within a band by priority
   * (urgent > high > medium > low), then soonest dueDate (undated last), then oldest first.
   */
  async listTasks(filters = {}) {
    let tasks = this.rows(`SELECT * FROM tasks`);

    const status = optStr(filters.status);
    if (status === "open") {
      tasks = tasks.filter((t) => t.status !== "done");
    } else if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    if (filters.includeDone === false) tasks = tasks.filter((t) => t.status !== "done");

    const project = optStr(filters.project);
    if (project) tasks = tasks.filter((t) => t.project === project);

    const assignee = optStr(filters.assignee);
    if (assignee) tasks = tasks.filter((t) => t.assignee === assignee);

    const search = optStr(filters.search);
    if (search) {
      const needle = search.toLowerCase();
      tasks = tasks.filter(
        (t) => t.title.toLowerCase().includes(needle) || (t.description || "").toLowerCase().includes(needle),
      );
    }

    const sort = oneOf(filters.sort, ["attention", "created", "updated", "due"], "attention");
    tasks.sort(comparatorFor(sort));
    return tasks;
  }

  /**
   * attentionQueue(limit?) -> task[]
   * The top of the attention-sorted list with done tasks dropped. What an agent should read first.
   */
  async attentionQueue(limit = 10) {
    const open = await this.listTasks({ includeDone: false, sort: "attention" });
    return open.slice(0, Math.max(1, Number(limit) || 10));
  }

  // -------------------------------------------------------------------------------------------
  // updates (comments on a task)
  // -------------------------------------------------------------------------------------------

  /** addUpdate({taskId, body, author?}) -> update */
  async addUpdate(args = {}) {
    const taskId = str(args.taskId);
    const body = str(args.body).trim();
    if (!taskId) throw new Error("addUpdate: `taskId` is required.");
    if (!body) throw new Error("addUpdate: `body` is required.");
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`addUpdate: no task '${taskId}'.`);

    const t = nowIso();
    const id = newId("upd");
    this.ctx.storage.sql.exec(
      `INSERT INTO updates (id, taskId, body, author, createdAt) VALUES (?, ?, ?, ?, ?)`,
      id, taskId, body, optStr(args.author), t,
    );
    // An update is activity on the task; keep updatedAt honest so "recently touched" means it.
    this.ctx.storage.sql.exec(`UPDATE tasks SET updatedAt = ? WHERE id = ?`, t, taskId);
    this.broadcast();
    const found = this.rows(`SELECT * FROM updates WHERE id = ?`, id);
    return found[0];
  }

  /** listUpdates(taskId) -> update[], oldest first. */
  async listUpdates(taskId) {
    return this.rows(`SELECT * FROM updates WHERE taskId = ? ORDER BY createdAt ASC`, str(taskId));
  }

  /** deleteUpdate(id) -> {deleted} */
  async deleteUpdate(id) {
    this.ctx.storage.sql.exec(`DELETE FROM updates WHERE id = ?`, str(id));
    this.broadcast();
    return { deleted: str(id) };
  }

  // -------------------------------------------------------------------------------------------
  // aggregate reads
  // -------------------------------------------------------------------------------------------

  /**
   * snapshot(filters?) -> {tasks, projects, assignees, counts}
   * One round trip for a UI render: the filtered+sorted task list, all projects, the distinct
   * assignee roster, and per-status counts across all tasks (unfiltered).
   */
  async snapshot(filters = {}) {
    const [tasks, projects] = await Promise.all([this.listTasks(filters), this.listProjects()]);
    const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0, total: 0 };
    for (const row of this.rows(`SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`)) {
      counts[row.status] = row.n;
      counts.total += row.n;
    }
    const assignees = this.rows(
      `SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL ORDER BY assignee ASC`,
    ).map((r) => r.assignee);
    return { tasks, projects, assignees, counts };
  }

  /** Schema documentation for agents: the allowed enum values. */
  async describeSchema() {
    return {
      statuses: STATUSES,
      priorities: PRIORITIES,
      projectStatuses: PROJECT_STATUSES,
      attentionOrder: "blocked > in_progress > todo > done, then priority, then dueDate, then createdAt",
    };
  }

  // -------------------------------------------------------------------------------------------
  // backup / restore
  // -------------------------------------------------------------------------------------------

  /**
   * exportAll() -> a complete, self-describing snapshot of this gadget's storage:
   *
   *   { gadget: "tasks", schemaVersion, exportedAt, counts: {...}, data: { <table>: [...rows] } }
   *
   * Every row of every table, every column, no truncation and no filtering. Read-only.
   */
  async exportAll() {
    const data = {};
    const counts = {};
    for (const table of EXPORT_TABLES) {
      const rows = this.rows(`SELECT ${table.columns.join(", ")} FROM ${table.name}`);
      data[table.name] = rows;
      counts[table.name] = rows.length;
    }
    return {
      gadget: GADGET_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: nowIso(),
      counts,
      data,
    };
  }

  /**
   * importAll(snapshot, {mode}) -> {imported, skipped, mode}
   *
   * The restore half of exportAll(). `mode: "replace"` (default "merge") empties the tables first,
   * so the result is exactly the snapshot; `mode: "merge"` upserts by natural key (task/project/
   * update `id`), leaving rows the snapshot doesn't mention alone.
   */
  async importAll(snapshot, options = {}) {
    validateSnapshot(snapshot);
    const mode = oneOf(options && options.mode, ["replace", "merge"], "merge");
    const sql = this.ctx.storage.sql;

    if (mode === "replace") {
      for (const table of [...EXPORT_TABLES].reverse()) sql.exec(`DELETE FROM ${table.name}`);
    }

    let imported = 0;
    let skipped = 0;
    for (const table of EXPORT_TABLES) {
      const incoming = snapshot.data[table.name];
      if (!Array.isArray(incoming)) continue;
      const placeholders = table.columns.map(() => "?").join(", ");
      const assignments = table.columns
        .filter((c) => c !== table.key)
        .map((c) => `${c} = excluded.${c}`)
        .join(", ");
      for (const row of incoming) {
        if (!row || typeof row !== "object" || row[table.key] === undefined || row[table.key] === null) {
          skipped++;
          continue;
        }
        const values = table.columns.map((c) => (row[c] === undefined ? null : row[c]));
        sql.exec(
          `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders})
           ON CONFLICT(${table.key}) DO UPDATE SET ${assignments}`,
          ...values,
        );
        imported++;
      }
    }

    this.broadcast();
    return { imported, skipped, mode };
  }
}

// ---------------------------------------------------------------------------------------------
// backup helpers
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------------------------

function dueRank(task) {
  if (!task.dueDate) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(task.dueDate);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

function comparatorFor(sort) {
  if (sort === "created") return (a, b) => cmpStr(b.createdAt, a.createdAt);
  if (sort === "updated") return (a, b) => cmpStr(b.updatedAt, a.updatedAt);
  if (sort === "due") return (a, b) => dueRank(a) - dueRank(b) || cmpStr(a.createdAt, b.createdAt);
  return (a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    dueRank(a) - dueRank(b) ||
    cmpStr(a.createdAt, b.createdAt);
}

function cmpStr(a, b) {
  const x = a || "";
  const y = b || "";
  return x < y ? -1 : x > y ? 1 : 0;
}
