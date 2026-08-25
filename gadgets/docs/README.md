# MyoPlan Docs — path-first document store

The third of the first-party gadget trio (Tasks, Memory, Docs). It ports the old
MyoPlan HQ notes model: long-form markdown documents addressed by a **path**.
The **RPC surface is the product** — agents call it from `executeCode` via the
gadget's stub; `client.js` is a thin two-pane reader/editor over the same methods.

## Data model

One table, `documents`, in Durable Object SQLite:

| field | notes |
|---|---|
| `id` | uuid, server-assigned |
| `path` | slash-separated kebab segments, **unique** — the identity of the document |
| `title` | human title; defaults to the humanized last path segment |
| `body` | markdown |
| `tags` | array of kebab-case tags |
| `createdAt` / `updatedAt` | epoch ms |

**Folders are implicit.** There is no folder table — a folder exists because a
document underneath it exists, and disappears when the last one is deleted.
`tree()` derives the hierarchy from the set of paths.

Paths are normalized on **every** call: each `/`-separated segment is trimmed,
lowercased, and kebab-cased, and empty segments are dropped. So
`write({ path: "Company/ Agents " })` and `read("company/agents")` address the
same document. `normalize(path)` exposes the transform so an agent can preview
it. Limits: 80 chars per segment, 12 segments.

## RPC surface

```js
// upsert by path; returns { document, created }
await docs.write({ path, title, body, tags });

await docs.read("company/agents");            // full record, or null
await docs.delete("company/agents");          // true if one was removed  (alias: remove)
await docs.move("old/path", "new/path");      // rename; returns the moved document

await docs.list();                            // every summary, sorted by path
await docs.list("company/decisions");         // string arg == prefix
await docs.list({ prefix, tag });
await docs.listFull({ prefix, tag });         // full records (UI / bulk export)

await docs.search("migration");
await docs.search({ query, prefix, tag, limit });
// -> [{ path, title, tags, createdAt, updatedAt, score, excerpt }, ...]

await docs.tree();                            // nested folder structure
await docs.tags();                            // [{ tag, count }], most-used first
await docs.stats();                           // { documents, folders, tags, updatedAt }
await docs.normalize("Company/ Agents");      // -> "company/agents"
```

`subscribe(callback)` exists for the UI: `callback.update(event)` fires on every
write, move, and delete so open browsers re-fetch. Events are
`{ type: "changed" | "moved" | "removed", path, from? }`.

### `prefix` matches whole segments

`list({ prefix: "company" })` returns `company` itself and everything under
`company/`, but never `companywide/x`. An empty/absent prefix means everything.

### `tree()` shape

```js
{ name: "", path: "", count: 3, folders: [ { name, path, count, folders, documents } ], documents: [] }
```

`count` is the total number of documents at or **below** that folder, so a
collapsed folder can still show its weight. Folders and documents are sorted by
name/path. `tree({ prefix, tag })` narrows it with the same filters as `list()`.

### Search ranking

Per query term: exact last-segment match +20, path substring +8, title substring
+6, exact tag +5, plus up to 5 for body-term frequency. Ties break on
`updatedAt`, then path. Documents scoring 0 are dropped. An empty query returns
the head of the filtered list with score 0 — cheap enough to call speculatively.

## Conventions

- **Upsert, never duplicate.** `write()` on an existing path replaces title,
  body, and tags and bumps `updatedAt`; `id` and `createdAt` are preserved.
  Omitting `title` on an update keeps the existing title (it does *not* reset to
  the path-derived default).
- **Paths are the index.** Prefer a path someone else would guess over a clever
  title. Dated decisions lead with the date (`YYYY-MM-DD-slug`) so a folder
  sorts chronologically on path alone.
- **Renaming is `move()`, not a second `write()`.** `move()` refuses to clobber
  an occupied destination.
- Writes are serialized through a mutation queue so overlapping RPC calls can't
  interleave an upsert with its broadcast.

## Notes for future editors

- Every mutating method calls `broadcast()`, which fans `update()` out to
  subscribers. Keep that invariant: the UI has no polling.
- The sandboxed iframe inherits no styling from the host, so the palette lives in
  `client.js` as CSS custom properties with a `prefers-color-scheme: dark`
  override. There is no host theme channel.
- Init is wrapped in a try/catch that paints a visible failure panel into the
  body. The iframe sandbox swallows gadget-side exceptions, so without it a
  broken init is indistinguishable from a blank page — keep that wrapper.
- `normalizePath()` is duplicated in `client.js` (the editor previews the stored
  path as you type). If you change the rules in `server.js`, change both.
- The client treats a path edit on an existing document as `move()` **then**
  `write()`. That ordering matters: writing first would create a second document.
- On first boot with an empty `documents` table the server seeds three real
  documents, guarded by the `seeded:v1` storage key, so deleting them does not
  bring them back.

## Seeds

| path | what |
|---|---|
| `company/decisions/2026-08-23-migrate-hq-onto-cloudflare-os` | the migration decision |
| `company/agents` | agent operating guide (stub) |
| `readme` | what this store is + the RPC surface |
