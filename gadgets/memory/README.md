# MyoPlan Memory — agent-first memory store

A durable knowledge store modeled on MyoPlan HQ notes + Claude auto-memory. The
**RPC surface is the product**: agents call it from `executeCode` via the
gadget's stub. The browser UI is a thin reader/editor over the same methods.

## Data model

One table, `memories`, in Durable Object SQLite:

| field | notes |
|---|---|
| `id` | uuid, server-assigned |
| `name` | kebab-slug, **unique** — the identity of the memory |
| `description` | one line; the main signal for `recall()` ranking |
| `type` | `user` \| `feedback` \| `project` \| `reference` \| `decision` |
| `body` | markdown |
| `links` | array of memory names (wiki-link style) |
| `createdAt` / `updatedAt` | epoch ms |

Names are slugified on every path, so `recall("Old HQ")` and `get("old-hq")`
address the same record. `[[wiki links]]` written in the body are parsed out and
merged into `links` automatically — prose alone produces the graph.

## RPC surface

```js
// upsert by name; returns { memory, created }
await env.MEMORY.remember({ name, description, type, body, links: [] });

// ranked search over name + description + body
await env.MEMORY.recall("migration");
await env.MEMORY.recall({ query: "migration", type: "decision", limit: 5 });
// -> [{ name, description, type, links, updatedAt, score, excerpt }, ...]

await env.MEMORY.get("old-hq");        // full record, or null
await env.MEMORY.forget("old-hq");     // true if one was removed
await env.MEMORY.list();               // all summaries, newest first
await env.MEMORY.list({ type: "decision" });
await env.MEMORY.listFull();           // full records (UI / bulk export)
await env.MEMORY.related("old-hq");    // { name, outgoing, incoming, missing }
await env.MEMORY.types();              // valid type values
```

`related()` follows links in **both** directions: `outgoing` are the memories
this one links to, `incoming` are the ones that link back, and `missing` are
outgoing targets with no memory yet — a to-do list for the graph.

`subscribe(callback)` exists for the UI: the callback's `update(event)` fires on
every write so open browsers re-fetch.

## Conventions

- **Upsert, never duplicate.** `remember()` on an existing name replaces
  description/type/body/links and bumps `updatedAt`; `createdAt` and `id` are
  preserved.
- **Description earns its keep.** `recall()` weights name matches highest, then
  description, then body-term frequency. A vague description makes a memory
  unfindable.
- Writes are serialized through a mutation queue so overlapping RPC calls can't
  interleave an upsert with its broadcast.

## Seeds

Ships with three real memories: `myoplan-os-migration` (decision),
`core-gadgets` (project), `old-hq` (reference). They are written once, guarded by
the `seeded:v1` storage key, so clearing them out doesn't bring them back.
