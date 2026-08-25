# MyoPlan Tasks

A task tracker port of the MyoPlan HQ task model. `server.js` owns the data; `client.js` is the UI.
Both halves are meant to be used by agents as well as humans — the RPC surface is the product.

## Data model (DO SQLite, `ctx.storage.sql`)

- `tasks` — `id, title, description, status, priority, assignee, project, dueDate, createdAt, updatedAt, completedAt`
  - `status`: `todo | in_progress | blocked | done`
  - `priority`: `low | medium | high | urgent`
  - `project` holds a `projects.id`; `dueDate` is an ISO date (`YYYY-MM-DD`) or datetime string.
- `projects` — `id, title, status (active|paused|done|archived), createdAt, updatedAt`
- `updates` — `id, taskId, body, author, createdAt` — the comment thread on a task.

`completedAt` is derived, never passed in: it is stamped when a task moves to `done` and cleared
when it moves off `done`. Do not set it directly.

## RPC surface

Tasks: `createTask(args)`, `getTask(id)`, `updateTask(id, patch)`, `completeTask(id)`,
`reopenTask(id, status?)`, `deleteTask(id)`, `listTasks(filters)`, `attentionQueue(limit?)`.

Projects: `createProject({title, status?})`, `listProjects({status?})`, `getProject(id)`,
`updateProject(id, patch)`. `listProjects` decorates each row with `taskCount` / `openCount`.

Updates: `addUpdate({taskId, body, author?})`, `listUpdates(taskId)`, `deleteUpdate(id)`.

Aggregate: `snapshot(filters)` → `{tasks, projects, assignees, counts}` — one round trip for a full
render. `describeSchema()` → the allowed enum values. `subscribe(callback)` → `callback.changed()`
fires on every mutation, including mutations an agent makes through its own stub.

### `listTasks` filters

`{status, project, assignee, search, includeDone, sort}`. `status` also accepts the pseudo-value
`"open"` (everything but `done`). `search` is a case-insensitive substring over title + description.
`sort` is `attention` (default) | `created` | `updated` | `due`.

**Attention order** is the point of this gadget: `blocked` first, then `in_progress`, then `todo`,
with `done` last; within a band by priority (`urgent > high > medium > low`), then soonest `dueDate`
(undated last), then oldest first. `attentionQueue(n)` is that list with `done` dropped, truncated.

## Notes for future editors

- Every mutating method calls `broadcast()`, which fans `changed()` out to subscribers. Keep that
  invariant: the UI has no polling.
- The client re-renders the detail pane only when its *subject* changes (`renderedDetail`), so a
  background refresh never rebuilds a form under the user's cursor. Pass `renderDetail(true)` when
  you genuinely need to rebuild the same task's pane.
- The sandboxed iframe inherits no styling from the host, so the palette lives in `client.js` as CSS
  custom properties with a `prefers-color-scheme: dark` override. There is no host theme channel.
- Init is wrapped in a try/catch that paints a visible failure panel into the body. The iframe
  sandbox swallows gadget-side exceptions, so without it a broken init is indistinguishable from a
  blank page — keep that wrapper.
- Due dates are calendar days. Parse them with `parseDue()` (local midnight), never `Date.parse` —
  a bare `YYYY-MM-DD` is UTC midnight and renders as the previous day west of Greenwich.
- On first boot with an empty `tasks` table the server seeds one project and four sample tasks so a
  fresh instance demos. Deleting them all does not re-seed (the check runs only when the table is
  empty *at construction*, which after any write it never is again for that instance).
