// A tiny in-process harness for exercising a first-party gadget's `server.js` (a Durable Object)
// under `node --test`, without a workerd runtime.
//
// A gadget stores everything in `ctx.storage.sql` (SQLite in the DO) and `ctx.storage` key/value,
// and its public methods are the product. This harness stands up a real SQLite database (Node's
// built-in `node:sqlite`) behind a `ctx` shaped like the runtime's, loads the gadget's `server.js`
// (with `cloudflare:workers` shimmed by gadget-do-loader.mjs), constructs the `Gadget`, and returns
// the live instance -- so a test can call `gadget.submit(...)`, `gadget.exportAll()`, etc. exactly
// as client.js and agents do in production.
//
// It is plain JS (like scripts/oxlint-plugin.mjs) rather than TypeScript on purpose: gadget code is
// itself plain JS, and this keeps `node --test` able to run the gadget suites directly, with no
// TypeScript-aware Node build required.
//
// It is intentionally faithful only to the surface real gadgets use: `ctx.storage.sql.exec(...)`
// returning a cursor with `.toArray()`, `ctx.storage.{get,put,delete}`, and
// `ctx.blockConcurrencyWhile(fn)` (whose promise the harness awaits before handing the gadget
// back, since the runtime guarantees the constructor's migration has settled before the first RPC).

import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

let loaderRegistered = false;

/** Register the `cloudflare:workers` shim exactly once per process. */
function ensureLoader() {
  if (loaderRegistered) return;
  register("./gadget-do-loader.mjs", import.meta.url);
  loaderRegistered = true;
}

/** True for statements that yield rows, so the shim reads them instead of just executing. */
function returnsRows(query) {
  return /^\s*(select|with|pragma)/i.test(query) || /\breturning\b/i.test(query);
}

/**
 * Build a subscriber double for `subscribe(callback)`. It records how many `changed()` pushes it
 * saw (`.changes`), and satisfies the `.dup()` / `.onRpcBroken()` shape a gadget expects of a
 * capnweb stub. Pass it straight to `gadget.subscribe(...)`.
 */
export function makeSubscriber() {
  const sub = {
    changes: 0,
    dup: () => sub,
    onRpcBroken(fn) {
      sub.break = fn;
    },
    changed() {
      sub.changes += 1;
    },
    break() {
      // Replaced by onRpcBroken's callback; a no-op until then.
    },
  };
  return sub;
}

/** Assemble a fake DO context backed by a fresh in-memory SQLite database. */
function makeContext() {
  const db = new DatabaseSync(":memory:");
  const kv = new Map();
  const statements = new Map();
  const ready = [];

  const prepare = (query) => {
    let stmt = statements.get(query);
    if (!stmt) {
      stmt = db.prepare(query);
      statements.set(query, stmt);
    }
    return stmt;
  };

  const sql = {
    exec(query, ...bindings) {
      const stmt = prepare(query);
      if (returnsRows(query)) {
        const rows = stmt.all(...bindings);
        return { toArray: () => rows };
      }
      stmt.run(...bindings);
      return { toArray: () => [] };
    },
  };

  return {
    db,
    ready,
    ctx: {
      storage: {
        sql,
        async get(key) {
          return kv.get(key);
        },
        async put(key, value) {
          kv.set(key, value);
        },
        async delete(key) {
          return kv.delete(key);
        },
      },
      blockConcurrencyWhile(fn) {
        const promise = fn();
        ready.push(promise);
        return promise;
      },
    },
  };
}

/**
 * Load `serverPath`'s exported `Gadget` class, construct it against a fresh SQLite-backed context,
 * wait for its constructor migration to settle, and return `{ gadget, context }`. Each call is a
 * brand-new, isolated database, so tests never bleed into one another. `env` is handed to the
 * Gadget constructor verbatim (gadgets read it for test seams like `seedSamples: false`).
 */
export async function loadGadget(serverPath, env = {}) {
  ensureLoader();
  const module = await import(pathToFileURL(serverPath).href);
  const context = makeContext();
  const gadget = new module.Gadget(context.ctx, env);
  await Promise.all(context.ready);
  return { gadget, context };
}
