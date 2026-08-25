#!/usr/bin/env node
// Keeps gadgets/<name>/{server.js,client.js,README.md} in sync with the source actually
// deployed on the live MyoPlan OS instance. See gadgets/README.md for the full model.
//
// Usage:
//   pnpm os-gadget pull [--gadget <name>]   fetch prod source into gadgets/<name>/, report drift
//   pnpm os-gadget check                    fetch prod, assert it matches the repo byte-for-byte
//
// There is deliberately no `push` mode here -- publishing a gadget always goes through the
// explicit code:write / code:merge / blueprint:publish flow (see gadgets/README.md), so nobody
// force-overwrites a live gadget from a stale local file by running a sync script.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./os-client/env.ts";
import { connectAuthenticated, disposeQuietly } from "./os-client/client.ts";

loadDotEnv();

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GADGETS_DIR = join(ROOT, "gadgets");

// wsId of each gadget's workspace; gadget index within it is always 0 for these three.
const GADGETS: { name: string; wsId: string }[] = [
  { name: "tasks", wsId: "8d78489817bacda4e4b178de65e0f1ac50eded843b0e23e4c702c1d4a6aed564" },
  { name: "memory", wsId: "411258bdc55cf8950adcfb772970aa58c7b62def8c088cc5cfd750d442e0c546" },
  { name: "docs", wsId: "99af739b4c5e5d823f61743dc61b8045622016abe0f2fad3c11aa2833c896ce8" },
];

interface RemoteFiles {
  commitId: string | null;
  files: [string, string][];
}

async function fetchGadgetSource(wsId: string): Promise<RemoteFiles> {
  const { pub, auth } = await connectAuthenticated();
  try {
    const overseer = await auth.openGadget(wsId);
    try {
      const workpieces = await listWorkpieces(overseer);
      const summary = workpieces.find((w: { id: number }) => w.id === 0);
      if (!summary) throw new Error(`No gadget 0 in workspace ${wsId}.`);
      if (!summary.commitId) {
        return { commitId: null, files: [] };
      }
      const { files } = await overseer.getCodeAtCommit(summary.commitId);
      return { commitId: summary.commitId, files: files as [string, string][] };
    } finally {
      disposeQuietly(overseer);
    }
  } finally {
    disposeQuietly(pub);
  }
}

// Duplicated (not imported) from os-client/commands.ts: that helper isn't exported, and pulling
// in the whole subscription dance import surface here isn't worth it for one call site.
async function listWorkpieces(overseer: unknown): Promise<{ id: number; commitId: string | null }[]> {
  const { RpcStub, RpcTarget } = await import("capnweb");
  const entries: { id: number; commitId: string | null }[] = [];
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  class Subscriber extends RpcTarget {
    entry(summary: { id: number; commitId: string | null }): void {
      entries.push(summary);
    }
    removed(): void {
      // not relevant for a one-shot listing
    }
    ready(): void {
      resolveReady();
    }
  }

  const subscriber = new RpcStub(new Subscriber());
  const overseerStub = overseer as { subscribeToWorkpieces: (s: unknown) => Promise<unknown> };
  const subscription = await overseerStub.subscribeToWorkpieces(subscriber);
  try {
    await readyPromise;
    return entries;
  } finally {
    disposeQuietly(subscription as never);
    disposeQuietly(subscriber as never);
  }
}

function localFiles(name: string): Map<string, string> {
  const dir = join(GADGETS_DIR, name);
  const result = new Map<string, string>();
  for (const file of ["server.js", "client.js", "README.md"]) {
    const p = join(dir, file);
    if (existsSync(p)) result.set(file, readFileSync(p, "utf8"));
  }
  return result;
}

function diffSummary(local: Map<string, string>, remote: [string, string][]): string[] {
  const lines: string[] = [];
  const remoteMap = new Map(remote);
  const allPaths = new Set([...local.keys(), ...remoteMap.keys()]);
  for (const path of allPaths) {
    const l = local.get(path);
    const r = remoteMap.get(path);
    if (l === undefined) {
      lines.push(`  + ${path} (only on prod, ${r!.length} bytes)`);
    } else if (r === undefined) {
      lines.push(`  - ${path} (only on disk, ${l.length} bytes)`);
    } else if (l !== r) {
      lines.push(`  ~ ${path} (differs: disk ${l.length} bytes vs prod ${r.length} bytes)`);
    }
  }
  return lines;
}

async function pull(gadgetFilter?: string): Promise<void> {
  const targets = gadgetFilter ? GADGETS.filter((g) => g.name === gadgetFilter) : GADGETS;
  if (gadgetFilter && targets.length === 0) {
    throw new Error(`Unknown gadget "${gadgetFilter}". Known: ${GADGETS.map((g) => g.name).join(", ")}`);
  }

  for (const { name, wsId } of targets) {
    console.log(`\n=== ${name} ===`);
    const before = localFiles(name);
    const { commitId, files } = await fetchGadgetSource(wsId);
    if (!commitId) {
      console.log("  (gadget has no head commit yet -- nothing to pull)");
      continue;
    }
    const changes = diffSummary(before, files);
    if (changes.length === 0) {
      console.log(`  up to date (commit ${commitId})`);
    } else {
      console.log(`  commit ${commitId} -- drift vs disk:`);
      for (const line of changes) console.log(line);
    }

    const dir = join(GADGETS_DIR, name);
    mkdirSync(dir, { recursive: true });
    for (const [path, content] of files) {
      writeFileSync(join(dir, path), content, "utf8");
    }
    console.log(`  wrote ${files.length} file(s) to gadgets/${name}/`);
  }
}

async function check(): Promise<void> {
  let drifted = false;
  for (const { name, wsId } of GADGETS) {
    const before = localFiles(name);
    const { commitId, files } = await fetchGadgetSource(wsId);
    if (!commitId) {
      console.log(`${name}: gadget has no head commit on prod -- skipping comparison`);
      continue;
    }
    const changes = diffSummary(before, files);
    if (changes.length === 0) {
      console.log(`${name}: OK (matches prod commit ${commitId})`);
    } else {
      drifted = true;
      console.log(`${name}: DRIFT vs prod commit ${commitId}`);
      for (const line of changes) console.log(line);
    }
  }
  if (drifted) {
    console.error("\ngadgets/ is out of sync with prod. Run `pnpm os-gadget pull` to update the repo,");
    console.error("or publish local changes via code:write / code:merge / blueprint:publish.");
    process.exit(1);
  }
  console.log("\nAll gadgets match prod byte-for-byte.");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "pull") {
    const gadgetFlagIdx = rest.indexOf("--gadget");
    const gadgetFilter = gadgetFlagIdx !== -1 ? rest[gadgetFlagIdx + 1] : undefined;
    await pull(gadgetFilter);
  } else if (command === "check") {
    await check();
  } else {
    console.error("usage: os-gadget <pull [--gadget <name>] | check>");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
