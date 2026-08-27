# MyoPlan Feedback

A first-party triage inbox for alpha and future beta feedback. The Durable Object is the source of
truth; its RPC methods are used by both the responsive UI and agents submitting or triaging reports.

## Principles

- Preserve the original report, attribution, build/device/route/session context, and arbitrary bounded
  metadata. `body`, `reporter`, and `createdAt` cannot be changed after `submit`.
- Keep triage separate from delivery: status, category, severity, assignee, title and tags may evolve,
  while linking or promoting to Tasks never replaces the report.
- Make ingestion safe to retry with `externalId`, strict enums, and documented size limits.

## Data model

- `feedback`: original report/context plus triage fields and optional linked-task reference.
- `notes`: internal notes and immutable lifecycle events.
- `links`: duplicate (directed) and related (symmetric) report relationships.

Statuses are `new | reviewing | planned | resolved | closed`; categories are
`bug | idea | question | praise | other`; severities are
`none | low | medium | high | critical`.

## RPC surface

- Ingest/read: `submit(args)`, `get(id)`, `list(filters)`, `detail(id)`.
- Triage: `update(id, patch)`, `stats()`, `snapshot(filters)`, `describeSchema()`.
- History: `addNote(args)`, `listNotes(id)`, `deleteNote(noteId)`.
- Relationships: `markDuplicate(id, canonicalId)`, `clearDuplicate(id)`, `relate(a,b)`,
  `unrelate(a,b)`.
- Delivery: `linkTask(id, task)`, `unlinkTask(id)`, `promoteToTask(id, task)`.
- Operations: `subscribe(callback)`, `exportAll()`, `importAll(snapshot, {mode})`.

`list` accepts status (including pseudo-status `open`), category, severity, assignee, source, tag,
case-insensitive search, `includeDuplicates`, and `sort` (`triage`, `updated`, or `created`). Triage
ordering puts lifecycle band first, then severity, then newest.

Call `describeSchema()` before agent ingestion for the exact enum and length contract. Current limits:
20,000 characters per original body, 10,000 per note, 200 per short string/tag, 32 tags, and an
8,192-character JSON encoding for metadata.

## Backup and testing

`exportAll` includes every row from all three tables; `importAll` supports merge/upsert and destructive
replace. The operator CLI includes Feedback once `OS_FEEDBACK_WORKSPACE_ID` is configured; scratch
round-trip verification additionally requires `OS_FEEDBACK_BLUEPRINT_ID`.

Run the behavioural contract with:

```bash
pnpm test:gadgets
```

The client is framework-free and uses the host theme handshake plus light, preferred-dark, and
explicit-dark token blocks. On narrow screens it switches from split view to an inbox/detail drill-in.
