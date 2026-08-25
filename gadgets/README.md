# First-party gadgets (source of record)

This directory vendors the source of the three first-party gadgets running on the
live **MyoPlan OS** instance at `https://os.myoplan.app`: **Tasks**, **Memory**, **Docs**.

Each gadget is its own permanent workspace on that instance (not a workpiece inside
some other user's workspace). Before this directory existed, their code lived only
inside the live instance's SQLite-backed workpiece storage — reachable via
`code:read`, but not tracked by git, not diffable, not reviewable in a PR. This
directory is now **the authoring source of record**: make changes here, review them
like any other code change, then publish to the live instance with the workflow
below. The live instance remains **the deployment target** — it is what agents and
users actually talk to — but it should always match what's committed here.

## Workspace / gadget / blueprint ids

| Gadget | Workspace id | Gadget id (workpiece index) | Blueprint |
|---|---|---|---|
| Tasks | `8d78489817bacda4e4b178de65e0f1ac50eded843b0e23e4c702c1d4a6aed564` | `0` | see `blueprint:publish` output / `outputs:list` |
| Memory | `411258bdc55cf8950adcfb772970aa58c7b62def8c088cc5cfd750d442e0c546` | `0` | see `blueprint:publish` output / `outputs:list` |
| Docs | `99af739b4c5e5d823f61743dc61b8045622016abe0f2fad3c11aa2833c896ce8` | `0` | see `blueprint:publish` output / `outputs:list` |

These ids are stable identifiers for the live workspaces; keep this table in sync if
any gadget is ever recreated under a new workspace.

## The gadget programming model, in brief

Each gadget is a pair of files running in the MyoPlan OS ("Cloudflare OS fork")
runtime:

- **`server.js`** — a Durable Object class. Every method that's exported as public on
  the class is RPC-callable both from `client.js` (the UI) and from external agents
  (via `pnpm os-client rpc <wsId> <method> [jsonArgs...]`, or the platform's own
  agent-facing surfaces). There is no separate "API layer" — the DO class *is* the
  API.
  - Storage is `ctx.storage.sql` (SQLite in the Durable Object). No KV, no external
    database.
  - **No `fetch`.** Gadgets do not make outbound network calls; all capability comes
    through the DO's own storage and RPC surface.
- **`client.js`** — plain JS (no framework, no bundler) that builds DOM directly. It
  runs inside a sandboxed iframe and is given a `gadget` global — an RPC stub that
  calls straight through to the paired `server.js` instance. `RpcTarget` (from
  `capnweb`) is pre-imported/available for any client-side objects that need to
  receive callbacks from the server side (e.g. subscriptions).
  - Theming: the sandboxed iframe has no access to the host page's CSS. Gadgets pick
    up the live theme via a `postMessage` handshake with the parent frame (a
    `myoplan-theme` message carrying the current theme tokens), and apply it with the
    three-block CSS pattern used across all three gadgets: a `:root` block with light
    (default) values, a `@media (prefers-color-scheme: dark)` block, and a
    `[data-theme="dark"]` override block, so the gadget matches the host regardless of
    how the theme was chosen.

## Publish workflow (source here → live instance)

There is deliberately no automated "push" — publishing a gadget is always the
explicit three-step flow below, run by a human or an agent who has actually reviewed
the diff:

```bash
# 1. Write each changed file into the gadget's *chat* code stream (repeat per file).
pnpm os-client code:write <wsId> 0 <chatId> server.js --file gadgets/<name>/server.js
pnpm os-client code:write <wsId> 0 <chatId> client.js --file gadgets/<name>/client.js
pnpm os-client code:write <wsId> 0 <chatId> README.md --file gadgets/<name>/README.md

# 2. Accept the chat's proposed changes onto the gadget's head commit.
pnpm os-client code:merge <wsId> <chatId>

# 3. Update the blueprint so new installs pick up the change.
pnpm os-client blueprint:publish <wsId> 0 --title "<title>" --desc "<description>"
```

After merging, pull the result back down to confirm the repo and prod agree:

```bash
pnpm os-gadget check
```

### Gotcha: chat ids are not reliably `0`

`code:write` and `code:merge` both take a `chatId`, and it is tempting to assume the
gadget's original chat (often `0`) still exists. It doesn't always — Memory's chat
`0` was deleted at some point, so `0` now 404s for that workspace. Don't hardcode
`chatId`. Instead:

- `pnpm os-client ws:show <wsId>` lists the workspace's current chats — pick a live one, or
- `pnpm os-client chat:new <wsId> "<message>"` to start a fresh chat and use the
  returned `chatId`.

## Syncing source with prod

`scripts/os-gadget-sync.ts` (wired up as `pnpm os-gadget`) automates the read side
of the above:

- `pnpm os-gadget pull` — fetch current prod source for all three gadgets into
  `gadgets/<name>/`, and print a diff summary against what was already on disk (or
  `pnpm os-gadget pull --gadget tasks` for just one).
- `pnpm os-gadget check` — fetch prod and assert it matches the repo byte-for-byte
  for all three gadgets; exits non-zero (and prints a diff) on any drift. This is
  the guard against "someone edited prod directly (or merged a chat without
  updating this repo) and now the repo is stale."

There is intentionally no `push` mode in this script — publishing always goes
through the explicit `code:write` / `code:merge` / `blueprint:publish` flow above,
so nobody accidentally force-overwrites a live gadget from a stale local file.
