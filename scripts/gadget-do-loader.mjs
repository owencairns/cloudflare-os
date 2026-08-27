// Module-resolution hooks used only by the gadget test harness (scripts/gadget-do-harness.ts).
//
// A gadget's `server.js` runs inside the MyoPlan OS runtime and begins with
// `import { DurableObject } from "cloudflare:workers"`. That specifier does not resolve under
// plain Node, so these hooks stand a minimal `DurableObject` base class in for it -- just enough
// for `class Gadget extends DurableObject` to construct. Everything else the gadget touches
// (`ctx.storage.sql`, `ctx.blockConcurrencyWhile`, ...) is supplied by the fake context the
// harness builds, so this base class is deliberately empty beyond wiring `ctx`/`env`.

const VIRTUAL_URL = "virtual:cloudflare-workers";

/** Redirect the `cloudflare:workers` bare specifier to our virtual module. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: VIRTUAL_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

/** Serve the virtual module: a no-frills `DurableObject` whose constructor records ctx/env. */
export async function load(url, context, nextLoad) {
  if (url === VIRTUAL_URL) {
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export class DurableObject {\n" +
        "  constructor(ctx, env) { this.ctx = ctx; this.env = env; }\n" +
        "}\n",
    };
  }
  return nextLoad(url, context);
}
