#!/usr/bin/env node
// Backup / restore for the first-party MyoPlan OS source-of-record gadgets.
//
// Every gadget keeps its company data in its own Durable Object's SQLite storage, which has no
// export, no snapshot, and no recovery path of its own. Each gadget's server.js exposes
// `exportAll()` / `importAll(snapshot, {mode})`; this script is the operator-facing half: it pulls
// a complete snapshot to local JSON, and can push one back.
//
// Usage (from the repo root):
//   pnpm os-backup                                  back up Tasks -> backups/<ISO-date>/
//   pnpm os-backup --gadget tasks                   back up Tasks explicitly
//   pnpm os-backup --out /some/where                write somewhere else
//   pnpm os-backup --verify                         backup, then prove the snapshot restores by
//                                                   round-tripping it through a scratch workspace
//   pnpm os-backup --restore backups/2026-08-25 --gadget docs [--mode replace|merge]
//
// `--verify` never touches prod data: it installs the gadget's blueprint into a brand-new scratch
// workspace, importAll()s the snapshot there, exports it again, diffs the two, then deletes the
// scratch workspace.
//
// Restores default to `--mode merge` (upsert by natural key, leave unmentioned rows alone).
// `--mode replace` empties the tables first and is the disaster-recovery mode.

import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { connectAuthenticated, disposeQuietly, getOsUrl } from "../os-client/client.ts";
import { loadDotEnv } from "../os-client/env.ts";

loadDotEnv();

// ---------------------------------------------------------------------------------------------
// the gadget roster
// ---------------------------------------------------------------------------------------------

/** A gadget's `exportAll()` payload. `data` is table name -> every row, verbatim. */
interface Snapshot {
  gadget: string;
  schemaVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
  data: Record<string, unknown[]>;
}

interface GadgetSpec {
  /** Matches the `gadget` field the gadget's own exportAll() stamps into the snapshot. */
  name: string;
  workspaceId: string;
  /** Used only by --verify, to stand up a throwaway copy of the gadget. */
  blueprintId: string;
}

const GADGETS: GadgetSpec[] = [
  {
    name: "tasks",
    workspaceId: "8d78489817bacda4e4b178de65e0f1ac50eded843b0e23e4c702c1d4a6aed564",
    blueprintId: "71826818ade38c9bfe78705e53ea334c",
  },
  {
    name: "feedback",
    workspaceId: process.env.OS_FEEDBACK_WORKSPACE_ID ?? "",
    blueprintId: process.env.OS_FEEDBACK_BLUEPRINT_ID ?? "",
  },
];

/** The established first-party workspaces predate multi-gadget support and use gadget 0. */
const LEGACY_GADGET_INDEX = 0;
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// snapshot validation -- the "is this actually a backup?" check
// ---------------------------------------------------------------------------------------------

/**
 * Mirrors the validator inside each gadget's importAll(), so a malformed snapshot is caught on
 * this side too -- before a restore is attempted, and as the cheap half of --verify.
 */
function validateSnapshot(value: unknown, expectedGadget?: string): Snapshot {
  const bad = (why: string): Error => new Error(`Invalid snapshot: ${why}`);

  if (!value || typeof value !== "object") throw bad("not an object.");
  const snapshot = value as Partial<Snapshot>;
  if (typeof snapshot.gadget !== "string") throw bad("`gadget` is missing.");
  if (expectedGadget && snapshot.gadget !== expectedGadget) {
    throw bad(`it is for gadget '${snapshot.gadget}', not '${expectedGadget}'.`);
  }
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw bad(
      `unsupported schemaVersion ${JSON.stringify(snapshot.schemaVersion)} (expected ${SCHEMA_VERSION}).`,
    );
  }
  if (typeof snapshot.exportedAt !== "string" || Number.isNaN(Date.parse(snapshot.exportedAt))) {
    throw bad("`exportedAt` is missing or not an ISO timestamp.");
  }
  if (!snapshot.data || typeof snapshot.data !== "object") throw bad("`data` is missing.");
  if (!snapshot.counts || typeof snapshot.counts !== "object") throw bad("`counts` is missing.");

  const data = snapshot.data as Record<string, unknown>;
  const counts = snapshot.counts as Record<string, unknown>;
  for (const [table, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) throw bad(`data.${table} is not an array.`);
    if (counts[table] !== rows.length) {
      throw bad(
        `counts.${table} says ${String(counts[table])} but data.${table} has ${rows.length} rows.`,
      );
    }
    for (const [i, row] of rows.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw bad(`data.${table}[${i}] is not a row object.`);
      }
    }
  }
  for (const table of Object.keys(counts)) {
    if (!(table in data))
      throw bad(`counts mentions table '${table}' that data has no rows array for.`);
  }
  return snapshot as Snapshot;
}

function totalRows(snapshot: Snapshot): number {
  return Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0);
}

// ---------------------------------------------------------------------------------------------
// talking to a gadget
// ---------------------------------------------------------------------------------------------

/**
 * Opens the gadget stub inside a workspace and hands it to `fn`. `connectToGadget()` returns the
 * live `Gadget` DO stub -- the same object client.js and agents call -- so `exportAll()` /
 * `importAll()` are just methods on it.
 */
async function withGadget<T>(
  auth: RpcStub<AuthenticatedApi>,
  workspaceId: string,
  fn: (gadget: RpcStub<Record<string, (...args: never[]) => Promise<unknown>>>) => Promise<T>,
  gadgetId: number = LEGACY_GADGET_INDEX,
): Promise<T> {
  const overseer = await auth.openGadget(workspaceId);
  try {
    const workpiece = await overseer.getGadget(gadgetId);
    try {
      const gadget = await workpiece.connectToGadget();
      try {
        return await fn(gadget as never);
      } finally {
        disposeQuietly(gadget);
      }
    } finally {
      disposeQuietly(workpiece);
    }
  } finally {
    disposeQuietly(overseer as RpcStub<Overseer>);
  }
}

async function exportGadget(auth: RpcStub<AuthenticatedApi>, spec: GadgetSpec): Promise<Snapshot> {
  const raw = await withGadget(
    auth,
    spec.workspaceId,
    (gadget) => gadget.exportAll() as Promise<unknown>,
  );
  return validateSnapshot(raw, spec.name);
}

async function importGadget(
  auth: RpcStub<AuthenticatedApi>,
  workspaceId: string,
  snapshot: Snapshot,
  mode: "replace" | "merge",
  gadgetId: number = LEGACY_GADGET_INDEX,
): Promise<{ imported: number; skipped: number }> {
  const result = await withGadget(
    auth,
    workspaceId,
    (gadget) => gadget.importAll(snapshot as never, { mode } as never) as Promise<unknown>,
    gadgetId,
  );
  return result as { imported: number; skipped: number };
}

// ---------------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------------

function defaultOutDir(): string {
  // Date, not full timestamp: one directory per day, re-running the same day overwrites it.
  return join(resolve(process.cwd(), "backups"), new Date().toISOString().slice(0, 10));
}

async function runBackup(specs: GadgetSpec[], outDir: string, verify: boolean): Promise<void> {
  const missing = specs.filter((spec) => !spec.workspaceId);
  if (missing.length) {
    throw new Error(
      `Missing workspace configuration for ${missing.map((spec) => spec.name).join(", ")}. ` +
        "Set OS_FEEDBACK_WORKSPACE_ID after provisioning, or select a configured gadget with --gadget.",
    );
  }
  if (verify && specs.some((spec) => !spec.blueprintId)) {
    throw new Error("--verify requires OS_FEEDBACK_BLUEPRINT_ID for Feedback.");
  }
  mkdirSync(outDir, { recursive: true });
  const { pub, auth } = await connectAuthenticated();
  try {
    console.log(`Backing up ${specs.length} gadget(s) from ${getOsUrl()} -> ${outDir}\n`);
    const written: { spec: GadgetSpec; snapshot: Snapshot; file: string; bytes: number }[] = [];

    for (const spec of specs) {
      const snapshot = await exportGadget(auth, spec);
      const file = join(outDir, `${spec.name}.json`);
      writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      const bytes = statSync(file).size;
      written.push({ spec, snapshot, file, bytes });
      const counts = Object.entries(snapshot.counts)
        .map(([table, n]) => `${table}=${n}`)
        .join(" ");
      console.log(
        `  ${spec.name.padEnd(7)} ${String(totalRows(snapshot)).padStart(5)} rows  ${formatBytes(bytes).padStart(9)}  ${counts}`,
      );
    }

    const totalBytes = written.reduce((sum, w) => sum + w.bytes, 0);
    console.log(
      `\n${written.length} snapshot(s), ${written.reduce((s, w) => s + totalRows(w.snapshot), 0)} rows, ${formatBytes(totalBytes)} in ${outDir}`,
    );

    if (verify) {
      console.log("");
      for (const { spec, snapshot } of written) {
        await verifyRoundTrip(auth, spec, snapshot);
      }
    }
  } finally {
    disposeQuietly(pub);
  }
}

/**
 * Proof that the snapshot is restorable, without touching prod: install the gadget's blueprint into
 * a brand-new scratch workspace, importAll() the snapshot there in `replace` mode, export the
 * scratch copy, and require the two `data` blocks to be byte-identical. The scratch workspace is
 * deleted either way.
 */
async function verifyRoundTrip(
  auth: RpcStub<AuthenticatedApi>,
  spec: GadgetSpec,
  snapshot: Snapshot,
): Promise<void> {
  // Cheap check first: the snapshot has to survive a JSON round-trip and its own validator.
  const reparsed = validateSnapshot(JSON.parse(JSON.stringify(snapshot)), spec.name);
  if (JSON.stringify(reparsed) !== JSON.stringify(snapshot)) {
    throw new Error(`${spec.name}: snapshot is not JSON-stable.`);
  }

  const scratch = await auth.newGadgetFromBlueprint(spec.blueprintId, {});
  let scratchId: string | undefined;
  try {
    const metadata = (await scratch.getMetadata()) as { id?: string; defaultGadgetId?: number };
    scratchId = metadata.id;
    await scratch.setTitle(`[scratch] ${spec.name} restore verification`);
    if (!scratchId) throw new Error("scratch workspace has no id");
    if (metadata.defaultGadgetId === undefined) {
      throw new Error("scratch workspace has no default gadget id");
    }

    const result = await importGadget(
      auth,
      scratchId,
      snapshot,
      "replace",
      metadata.defaultGadgetId,
    );
    const restored = await exportByWorkspace(auth, scratchId, spec.name, metadata.defaultGadgetId);
    const before = JSON.stringify(snapshot.data);
    const after = JSON.stringify(restored.data);
    if (before !== after) {
      throw new Error(
        `${spec.name}: round-trip MISMATCH -- restored snapshot differs from the backup ` +
          `(${before.length} vs ${after.length} bytes of data).`,
      );
    }
    console.log(
      `  verify ${spec.name.padEnd(7)} OK  imported=${result.imported} skipped=${result.skipped}  ` +
        `${totalRows(restored)} rows re-exported identically (scratch ws ${scratchId.slice(0, 12)}…)`,
    );
  } finally {
    try {
      await scratch.deleteSelf();
    } catch (err) {
      console.error(
        `  verify ${spec.name}: could not delete scratch workspace ${scratchId ?? "?"} -- delete it by hand. (${String(err)})`,
      );
    }
    disposeQuietly(scratch as RpcStub<Overseer>);
  }
}

/** exportGadget() by raw workspace id, for workspaces not in the roster (the --verify scratch copy). */
async function exportByWorkspace(
  auth: RpcStub<AuthenticatedApi>,
  workspaceId: string,
  expectedGadget: string,
  gadgetId: number,
): Promise<Snapshot> {
  const raw = await withGadget(
    auth,
    workspaceId,
    (gadget) => gadget.exportAll() as Promise<unknown>,
    gadgetId,
  );
  return validateSnapshot(raw, expectedGadget);
}

async function runRestore(spec: GadgetSpec, dir: string, mode: "replace" | "merge"): Promise<void> {
  const file = join(resolve(dir), `${spec.name}.json`);
  const snapshot = validateSnapshot(JSON.parse(readFileSync(file, "utf8")), spec.name);
  console.log(
    `Restoring ${spec.name} from ${file}\n` +
      `  snapshot taken ${snapshot.exportedAt}, ${totalRows(snapshot)} rows\n` +
      `  target ${getOsUrl()} workspace ${spec.workspaceId.slice(0, 12)}…, mode=${mode}\n`,
  );
  if (mode === "replace") {
    console.log("  mode=replace: every table in the live gadget is emptied first.\n");
  }

  const { pub, auth } = await connectAuthenticated();
  try {
    const result = await importGadget(auth, spec.workspaceId, snapshot, mode);
    const after = await exportGadget(auth, spec);
    console.log(
      `  imported=${result.imported} skipped=${result.skipped}\n` +
        `  live gadget now holds ${totalRows(after)} rows (${Object.entries(after.counts)
          .map(([t, n]) => `${t}=${n}`)
          .join(" ")})`,
    );
  } finally {
    disposeQuietly(pub);
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function usage(): string {
  return `os-backup -- snapshot and restore the MyoPlan OS gadgets (${GADGETS.map((g) => g.name).join(", ")}).

Reads OS_URL / OS_TOKEN the same way os-client does (including ./.os-client.env).

  pnpm os-backup [--gadget <name>] [--out <dir>] [--verify]
      Export every gadget (or one) to <dir>/<gadget>.json.
      Default dir: backups/<YYYY-MM-DD>/.
      --verify additionally proves each snapshot restores, by installing the gadget's blueprint
      into a throwaway scratch workspace, importing there, re-exporting, and diffing. Prod data is
      never written; the scratch workspace is deleted afterwards.

  pnpm os-backup --restore <dir> --gadget <name> [--mode replace|merge]
      Push <dir>/<gadget>.json back into the live gadget.
      --mode merge (default) upserts by natural key; --mode replace empties the tables first.
`;
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument '${arg}'. See --help.`);
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function gadgetNamed(name: string): GadgetSpec {
  const spec = GADGETS.find((g) => g.name === name);
  if (!spec)
    throw new Error(`Unknown gadget '${name}'. Known: ${GADGETS.map((g) => g.name).join(", ")}.`);
  return spec;
}

async function main(): Promise<void> {
  loadDotEnv();
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(usage());
    return;
  }

  const gadgetFlag = typeof flags.gadget === "string" ? flags.gadget : undefined;

  if (typeof flags.restore === "string") {
    if (!gadgetFlag) throw new Error("--restore requires --gadget <name>.");
    const mode = flags.mode === undefined ? "merge" : String(flags.mode);
    if (mode !== "replace" && mode !== "merge")
      throw new Error("--mode must be 'replace' or 'merge'.");
    await runRestore(gadgetNamed(gadgetFlag), flags.restore, mode);
    return;
  }
  if (flags.restore === true) throw new Error("--restore requires a directory.");

  const configured = GADGETS.filter((spec) => spec.workspaceId);
  if (!gadgetFlag && configured.length !== GADGETS.length) {
    const skipped = GADGETS.filter((spec) => !spec.workspaceId).map((spec) => spec.name);
    console.warn(`Skipping unconfigured gadget(s): ${skipped.join(", ")}.`);
  }
  const specs = gadgetFlag ? [gadgetNamed(gadgetFlag)] : configured;
  const outDir = typeof flags.out === "string" ? resolve(flags.out) : defaultOutDir();
  await runBackup(specs, outDir, flags.verify === true);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
