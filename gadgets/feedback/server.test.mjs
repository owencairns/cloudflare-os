// Behaviour tests for the first-party MyoPlan OS Feedback gadget's Durable Object (`server.js`).
//
// These run under `node --test` via the SQLite-backed harness in scripts/gadget-do-harness.mjs --
// no workerd. They are the contract for the RPC surface, which is *also* the agent ingestion API,
// so they lean on the guarantees that matter for that: strict validation, bounded lengths,
// idempotent submission, preservation of the original report + attribution, the triage lifecycle,
// dedupe/related links, task-promotion linkage, and exportAll/importAll backup parity.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadGadget, makeSubscriber } from "../../scripts/gadget-do-harness.mjs";

const SERVER = fileURLToPath(new URL("./server.js", import.meta.url));

// Every test starts from an empty tracker: `env.seedSamples: false` skips the demo seed so counts
// are exactly what the test itself inserts.
async function fresh() {
  const { gadget } = await loadGadget(SERVER, { seedSamples: false });
  return gadget;
}

async function rejects(promise, match) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Error, "expected an Error");
    assert.match(err.message, match);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// submit -- ingestion, defaults, preservation of the original report + attribution
// ---------------------------------------------------------------------------------------------

test("submit requires a non-empty body", async () => {
  const g = await fresh();
  await rejects(g.submit({}), /body/i);
  await rejects(g.submit({ body: "   " }), /body/i);
});

test("submit stores the report with sensible defaults and echoes context", async () => {
  const g = await fresh();
  const fb = await g.submit({
    body: "The workout timer skips a rep on iOS.",
    source: "ios",
    surface: "WorkoutPlayerView",
    appVersion: "1.4.0",
    appBuild: "impact-7",
    device: "iPhone 15 Pro",
    os: "iOS 26.1",
    route: "/session/active",
    inputMode: "touch",
    traceId: "trace-abc",
    sessionId: "sess-xyz",
    reporter: { id: "usr_1", name: "Alpha Tester", email: "a@example.com" },
    tags: ["timer", "ios"],
    metadata: { battery: 42, buildChannel: "alpha" },
  });

  assert.match(String(fb.id), /^fbk_/);
  assert.equal(fb.body, "The workout timer skips a rep on iOS.");
  assert.equal(fb.status, "new");
  assert.equal(fb.category, "other");
  assert.equal(fb.severity, "none");
  assert.equal(fb.source, "ios");
  assert.equal(fb.surface, "WorkoutPlayerView");
  assert.equal(fb.appVersion, "1.4.0");
  assert.equal(fb.appBuild, "impact-7");
  assert.equal(fb.device, "iPhone 15 Pro");
  assert.equal(fb.os, "iOS 26.1");
  assert.equal(fb.route, "/session/active");
  assert.equal(fb.inputMode, "touch");
  assert.equal(fb.traceId, "trace-abc");
  assert.equal(fb.sessionId, "sess-xyz");
  assert.deepEqual(fb.reporter, { id: "usr_1", name: "Alpha Tester", email: "a@example.com" });
  assert.deepEqual(fb.tags, ["timer", "ios"]);
  assert.deepEqual(fb.metadata, { battery: 42, buildChannel: "alpha" });
  assert.ok(typeof fb.createdAt === "string" && !Number.isNaN(Date.parse(String(fb.createdAt))));
  assert.equal(fb.resolvedAt, null);
});

test("submit accepts an explicit category/severity and trims/normalises", async () => {
  const g = await fresh();
  const fb = await g.submit({
    body: "Great app!",
    category: "praise",
    severity: "low",
    source: "  web  ",
  });
  assert.equal(fb.category, "praise");
  assert.equal(fb.severity, "low");
  assert.equal(fb.source, "web");
});

test("submit rejects unknown enum values strictly", async () => {
  const g = await fresh();
  await rejects(g.submit({ body: "x", category: "nonsense" }), /category/i);
  await rejects(g.submit({ body: "x", severity: "apocalyptic" }), /severity/i);
  await rejects(g.submit({ body: "x", status: "wobbling" }), /status/i);
});

// ---------------------------------------------------------------------------------------------
// bounded lengths
// ---------------------------------------------------------------------------------------------

test("submit enforces bounded lengths without truncating the original", async () => {
  const g = await fresh();
  await rejects(g.submit({ body: "x".repeat(20001) }), /body/i);
  await rejects(g.submit({ body: "ok", surface: "y".repeat(201) }), /surface/i);
  await rejects(
    g.submit({ body: "ok", tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }),
    /tags/i,
  );
  await rejects(g.submit({ body: "ok", tags: ["z".repeat(201)] }), /tag/i);
  await rejects(g.submit({ body: "ok", metadata: { blob: "m".repeat(9000) } }), /metadata/i);

  // A body exactly at the limit is accepted verbatim -- never silently shortened.
  const atLimit = "x".repeat(20000);
  const fb = await g.submit({ body: atLimit });
  assert.equal(fb.body, atLimit);
});

test("submit rejects metadata that is not a plain object and non-array tags", async () => {
  const g = await fresh();
  await rejects(g.submit({ body: "ok", metadata: [1, 2, 3] }), /metadata/i);
  await rejects(g.submit({ body: "ok", tags: "not-an-array" }), /tags/i);
});

// ---------------------------------------------------------------------------------------------
// idempotency by external submission id
// ---------------------------------------------------------------------------------------------

test("submit is idempotent by externalId", async () => {
  const g = await fresh();
  const first = await g.submit({ externalId: "ext-1", body: "first wording", source: "agent" });
  const second = await g.submit({
    externalId: "ext-1",
    body: "different wording, ignored",
    source: "agent",
  });

  assert.equal(second.id, first.id);
  assert.equal(
    second.body,
    "first wording",
    "idempotent replay must not overwrite the stored report",
  );
  const all = await g.list({});
  assert.equal(all.length, 1, "a replayed externalId must not create a second row");
});

test("submissions without an externalId are always distinct", async () => {
  const g = await fresh();
  const a = await g.submit({ body: "same text" });
  const b = await g.submit({ body: "same text" });
  assert.notEqual(a.id, b.id);
  assert.equal((await g.list({})).length, 2);
});

// ---------------------------------------------------------------------------------------------
// list / filter / sort
// ---------------------------------------------------------------------------------------------

test("list filters by status, category, severity, assignee, source, tag and search", async () => {
  const g = await fresh();
  const bug = await g.submit({
    body: "crash on save",
    category: "bug",
    severity: "high",
    source: "web",
    tags: ["save"],
  });
  await g.update(String(bug.id), { assignee: "owen" });
  await g.submit({
    body: "please add dark mode",
    category: "idea",
    source: "ios",
    tags: ["theme"],
  });
  await g.submit({ body: "love the new charts", category: "praise", source: "web" });

  assert.equal((await g.list({ category: "bug" })).length, 1);
  assert.equal((await g.list({ severity: "high" })).length, 1);
  assert.equal((await g.list({ source: "web" })).length, 2);
  assert.equal((await g.list({ assignee: "owen" })).length, 1);
  assert.equal((await g.list({ tag: "theme" })).length, 1);
  assert.equal((await g.list({ search: "dark" })).length, 1);
  assert.equal((await g.list({ search: "SAVE" })).length, 1, "search is case-insensitive");
});

test("list status filter supports the 'open' pseudo-status", async () => {
  const g = await fresh();
  const a = await g.submit({ body: "a" });
  const b = await g.submit({ body: "b" });
  await g.update(String(a.id), { status: "resolved" });
  await g.update(String(b.id), { status: "closed" });
  const c = await g.submit({ body: "c" });

  const open = await g.list({ status: "open" });
  assert.deepEqual(
    open.map((f) => f.id),
    [c.id],
  );
  assert.equal((await g.list({ status: "resolved" })).length, 1);
});

test("triage sort orders by lifecycle band then severity then newest", async () => {
  const g = await fresh();
  const planned = await g.submit({ body: "planned item" });
  await g.update(String(planned.id), { status: "planned" });
  const lowNew = await g.submit({ body: "low new", severity: "low" });
  const critNew = await g.submit({ body: "critical new", severity: "critical" });

  const ordered = await g.list({ sort: "triage" });
  assert.deepEqual(
    ordered.map((f) => f.id),
    [critNew.id, lowNew.id, planned.id],
    "new before planned; within new, critical before low",
  );
});

test("list can hide reports marked as duplicates", async () => {
  const g = await fresh();
  const canonical = await g.submit({ body: "canonical" });
  const dupe = await g.submit({ body: "dupe" });
  await g.markDuplicate(String(dupe.id), String(canonical.id));

  assert.equal((await g.list({})).length, 2, "duplicates are included by default");
  const visible = await g.list({ includeDuplicates: false });
  assert.deepEqual(
    visible.map((f) => f.id),
    [canonical.id],
  );
});

// ---------------------------------------------------------------------------------------------
// stats / snapshot
// ---------------------------------------------------------------------------------------------

test("stats reports totals and per-dimension counts", async () => {
  const g = await fresh();
  const bug = await g.submit({ body: "b1", category: "bug", severity: "high" });
  await g.submit({ body: "b2", category: "bug", severity: "low" });
  await g.submit({ body: "i1", category: "idea" });
  await g.update(String(bug.id), { status: "resolved" });

  const stats = await g.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.open, 2, "open excludes resolved and closed");
  assert.equal(stats.byStatus.new, 2);
  assert.equal(stats.byStatus.resolved, 1);
  assert.equal(stats.byCategory.bug, 2);
  assert.equal(stats.bySeverity.high, 1);
});

test("snapshot returns list, counts and facets in one round trip", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "one", tags: ["alpha"] });
  await g.update(String(fb.id), { assignee: "gina" });

  const snap = await g.snapshot({});
  assert.ok(Array.isArray(snap.feedback));
  assert.equal(snap.counts.total, 1);
  assert.deepEqual(snap.assignees, ["gina"]);
  assert.deepEqual(snap.tags, ["alpha"]);
});

// ---------------------------------------------------------------------------------------------
// update -- lifecycle, immutability of the original report + attribution
// ---------------------------------------------------------------------------------------------

test("update changes triage fields but never the original body or reporter", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "original wording", reporter: { id: "u1", name: "Tester" } });
  const updated = await g.update(String(fb.id), {
    status: "reviewing",
    category: "bug",
    severity: "high",
    assignee: "owen",
    title: "Timer bug",
    tags: ["timer"],
    // These are ignored: the original report is preserved.
    body: "TAMPERED",
    reporter: { id: "hacker" },
    createdAt: "1999-01-01T00:00:00.000Z",
  });

  assert.equal(updated.status, "reviewing");
  assert.equal(updated.category, "bug");
  assert.equal(updated.severity, "high");
  assert.equal(updated.assignee, "owen");
  assert.equal(updated.title, "Timer bug");
  assert.deepEqual(updated.tags, ["timer"]);
  assert.equal(updated.body, "original wording", "body is immutable after submit");
  assert.deepEqual(updated.reporter, { id: "u1", name: "Tester" }, "attribution is immutable");
  assert.equal(updated.createdAt, fb.createdAt, "createdAt is immutable");
});

test("resolving stamps resolvedAt; reopening clears it", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  const resolved = await g.update(String(fb.id), { status: "resolved" });
  assert.ok(typeof resolved.resolvedAt === "string" && Date.parse(String(resolved.resolvedAt)) > 0);
  const reopened = await g.update(String(fb.id), { status: "reviewing" });
  assert.equal(reopened.resolvedAt, null);
});

test("update rejects unknown enum values and unknown ids", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  await rejects(g.update(String(fb.id), { status: "bogus" }), /status/i);
  await rejects(g.update("fbk_missing", { status: "reviewing" }), /not found|no feedback/i);
});

test("status changes are recorded in the history timeline", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  await g.update(String(fb.id), { status: "reviewing" });
  const notes = await g.listNotes(String(fb.id));
  const events = notes.filter((n) => n.kind === "event");
  assert.ok(
    events.some((e) => /reviewing/i.test(String(e.body))),
    "a status-change event is logged",
  );
});

// ---------------------------------------------------------------------------------------------
// notes / internal history
// ---------------------------------------------------------------------------------------------

test("addNote appends an internal note and bumps updatedAt", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  const before = String((await g.get(String(fb.id))).updatedAt);
  const note = await g.addNote({
    feedbackId: String(fb.id),
    body: "looked into this",
    author: "owen",
  });
  assert.equal(note.kind, "note");
  assert.equal(note.body, "looked into this");
  const list = await g.listNotes(String(fb.id));
  assert.ok(list.some((n) => n.id === note.id));
  const after = String((await g.get(String(fb.id))).updatedAt);
  assert.ok(after >= before);
});

test("addNote validates body and bounds its length", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  await rejects(g.addNote({ feedbackId: String(fb.id), body: "   " }), /body/i);
  await rejects(g.addNote({ feedbackId: String(fb.id), body: "n".repeat(10001) }), /body|length/i);
  await rejects(g.addNote({ feedbackId: "fbk_missing", body: "hi" }), /not found|no feedback/i);
});

test("deleteNote removes a note", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  const note = await g.addNote({ feedbackId: String(fb.id), body: "temp" });
  await g.deleteNote(String(note.id));
  const list = await g.listNotes(String(fb.id));
  assert.ok(!list.some((n) => n.id === note.id));
});

// ---------------------------------------------------------------------------------------------
// dedupe / related
// ---------------------------------------------------------------------------------------------

test("markDuplicate links a report to its canonical and detail exposes both directions", async () => {
  const g = await fresh();
  const canonical = await g.submit({ body: "canonical" });
  const dupe = await g.submit({ body: "dupe" });
  await g.markDuplicate(String(dupe.id), String(canonical.id));

  const dupeDetail = await g.detail(String(dupe.id));
  assert.equal(dupeDetail.duplicateOf.id, canonical.id);

  const canonicalDetail = await g.detail(String(canonical.id));
  assert.deepEqual(
    canonicalDetail.duplicates.map((f) => f.id),
    [dupe.id],
  );
});

test("markDuplicate rejects self-links and unknown ids; clearDuplicate undoes it", async () => {
  const g = await fresh();
  const a = await g.submit({ body: "a" });
  const b = await g.submit({ body: "b" });
  await rejects(g.markDuplicate(String(a.id), String(a.id)), /itself|self/i);
  await rejects(g.markDuplicate(String(a.id), "fbk_missing"), /not found|no feedback/i);

  await g.markDuplicate(String(a.id), String(b.id));
  await g.clearDuplicate(String(a.id));
  const detail = await g.detail(String(a.id));
  assert.equal(detail.duplicateOf, null);
});

test("relate creates a symmetric related link that is idempotent", async () => {
  const g = await fresh();
  const a = await g.submit({ body: "a" });
  const b = await g.submit({ body: "b" });
  await g.relate(String(a.id), String(b.id));
  await g.relate(String(b.id), String(a.id)); // idempotent, either direction

  const detailA = await g.detail(String(a.id));
  const detailB = await g.detail(String(b.id));
  assert.deepEqual(
    detailA.related.map((f) => f.id),
    [b.id],
  );
  assert.deepEqual(
    detailB.related.map((f) => f.id),
    [a.id],
  );

  await g.unrelate(String(a.id), String(b.id));
  assert.deepEqual((await g.detail(String(a.id))).related, []);
});

// ---------------------------------------------------------------------------------------------
// promotion to a linked task -- without destroying the original
// ---------------------------------------------------------------------------------------------

test("linkTask records a task reference and preserves the report", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "make the button bigger" });
  const linked = await g.linkTask(String(fb.id), {
    taskId: "tsk_42",
    taskTitle: "Bigger button",
    taskUrl: "https://os.myoplan.app/t/42",
  });
  assert.equal(linked.linkedTaskId, "tsk_42");
  assert.equal(linked.linkedTaskTitle, "Bigger button");
  assert.equal(linked.linkedTaskUrl, "https://os.myoplan.app/t/42");
  assert.equal(linked.body, "make the button bigger", "linking never destroys the original report");

  const cleared = await g.unlinkTask(String(fb.id));
  assert.equal(cleared.linkedTaskId, null);
});

test("linkTask requires a taskId and a known feedback id", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  await rejects(g.linkTask(String(fb.id), {}), /taskId/i);
  await rejects(g.linkTask("fbk_missing", { taskId: "tsk_1" }), /not found|no feedback/i);
});

test("promoteToTask links and moves the report into the planned band", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "x" });
  const promoted = await g.promoteToTask(String(fb.id), { taskId: "tsk_7" });
  assert.equal(promoted.linkedTaskId, "tsk_7");
  assert.equal(promoted.status, "planned");
  const notes = await g.listNotes(String(fb.id));
  assert.ok(
    notes.some((n) => n.kind === "event" && /tsk_7/.test(String(n.body))),
    "promotion is logged",
  );
});

// ---------------------------------------------------------------------------------------------
// schema description
// ---------------------------------------------------------------------------------------------

test("describeSchema advertises the enums and limits agents must respect", async () => {
  const g = await fresh();
  const schema = await g.describeSchema();
  assert.deepEqual(schema.statuses, ["new", "reviewing", "planned", "resolved", "closed"]);
  assert.ok(Array.isArray(schema.categories) && schema.categories.includes("bug"));
  assert.ok(Array.isArray(schema.severities) && schema.severities.includes("critical"));
  assert.equal(schema.limits.body, 20000);
});

// ---------------------------------------------------------------------------------------------
// subscriptions
// ---------------------------------------------------------------------------------------------

test("mutations broadcast changed() to subscribers", async () => {
  const g = await fresh();
  const sub = makeSubscriber();
  await g.subscribe(sub);
  const before = sub.changes;
  const fb = await g.submit({ body: "x" });
  await g.update(String(fb.id), { status: "reviewing" });
  await g.addNote({ feedbackId: String(fb.id), body: "note" });
  assert.ok(sub.changes >= before + 3, "each mutation pushes a change notification");
});

// ---------------------------------------------------------------------------------------------
// backup parity -- exportAll / importAll
// ---------------------------------------------------------------------------------------------

test("exportAll is a complete, self-describing snapshot", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "one", tags: ["a"], metadata: { k: 1 } });
  await g.addNote({ feedbackId: String(fb.id), body: "note" });
  const dupe = await g.submit({ body: "two" });
  await g.markDuplicate(String(dupe.id), String(fb.id));

  const snap = await g.exportAll();
  assert.equal(snap.gadget, "feedback");
  assert.equal(snap.schemaVersion, 1);
  assert.ok(typeof snap.exportedAt === "string");
  assert.equal(snap.data.feedback.length, 2);
  assert.ok(snap.data.notes.length >= 1);
  assert.ok(snap.data.links.length >= 1);
  assert.equal(snap.counts.feedback, 2);
});

test("importAll(replace) restores an export byte-for-byte", async () => {
  const source = await fresh();
  const fb = await source.submit({
    body: "restore me",
    category: "bug",
    tags: ["x"],
    metadata: { a: 1 },
  });
  await source.addNote({ feedbackId: String(fb.id), body: "context" });
  await source.update(String(fb.id), { status: "planned" });
  const snap = await source.exportAll();

  const target = await fresh();
  await target.submit({ body: "will be wiped" });
  const result = await target.importAll(snap, { mode: "replace" });
  assert.ok(result.imported >= 1);

  const roundTrip = await target.exportAll();
  assert.deepEqual(roundTrip.data.feedback, snap.data.feedback);
  assert.deepEqual(roundTrip.data.notes, snap.data.notes);
  assert.deepEqual(roundTrip.data.links, snap.data.links);
});

test("importAll rejects a snapshot from a different gadget", async () => {
  const g = await fresh();
  await rejects(g.importAll({ gadget: "tasks", schemaVersion: 1, data: {} }), /tasks|feedback/i);
  await rejects(
    g.importAll({ gadget: "feedback", schemaVersion: 99, data: {} }),
    /schemaVersion|version/i,
  );
});

test("importAll(merge) upserts by id and round-trips through export", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "original" });
  const snap = await g.exportAll();
  // Restore the same snapshot in merge mode: it must upsert, not duplicate.
  await g.importAll(snap, { mode: "merge" });
  assert.equal((await g.list({})).length, 1);
  assert.equal(String((await g.get(String(fb.id))).body), "original");
});

test("deleteNote refuses to erase immutable lifecycle events", async () => {
  const g = await fresh();
  const fb = await g.submit({ body: "preserve history" });
  await g.update(String(fb.id), { status: "reviewing" });
  const event = (await g.listNotes(String(fb.id))).find((note) => note.kind === "event");
  await rejects(g.deleteNote(String(event.id)), /lifecycle|event|immutable/i);
  assert.equal(
    (await g.listNotes(String(fb.id))).some((note) => note.id === event.id),
    true,
  );
});

test("importAll replace validates every row before deleting live data", async () => {
  const g = await fresh();
  const live = await g.submit({ body: "must survive a bad restore" });
  const snapshot = await g.exportAll();
  snapshot.data.feedback = [{ id: "broken", body: null }];

  await rejects(g.importAll(snapshot, { mode: "replace" }), /feedback|body|required|snapshot/i);
  assert.equal((await g.get(String(live.id))).body, live.body);
});

test("importAll merge rejects externalId ownership conflicts without replacing live rows", async () => {
  const g = await fresh();
  const live = await g.submit({ externalId: "submission-1", body: "original" });
  const snapshot = await g.exportAll();
  snapshot.data.feedback[0] = {
    ...snapshot.data.feedback[0],
    id: "fbk_other",
    body: "replacement",
  };

  await rejects(g.importAll(snapshot, { mode: "merge" }), /externalId|conflict/i);
  assert.equal((await g.get(String(live.id))).body, "original");
  assert.equal(await g.get("fbk_other"), null);
});
