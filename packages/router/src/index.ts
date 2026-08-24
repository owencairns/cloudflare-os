// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev. */
  ASSETS?: Fetcher;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  [key: string]: unknown;
}

/**
 * The OAuth authorization server's paths, which belong to the backend rather than the single-page
 * app. Mirrors `isOAuthPath()` in workshop-backend (src/auth/oauth/endpoints.ts) -- duplicated
 * rather than imported because this worker deliberately depends on nothing, and it must agree with
 * `run_worker_first` in wrangler.jsonc anyway, which is a list of strings either way.
 *
 * `/oauth/approve` is pointedly **not** here: the approval screen is a frontend route, so it must
 * fall through to the SPA.
 *
 * The well-known paths match by prefix so the spec's path-inserted variants
 * (`/.well-known/oauth-protected-resource/mcp`) reach the backend too.
 */
function isOAuthBackendPath(pathname: string): boolean {
  for (const wellKnown of ["/.well-known/oauth-protected-resource",
                           "/.well-known/oauth-authorization-server"]) {
    if (pathname === wellKnown || pathname.startsWith(wellKnown + "/")) return true;
  }
  return pathname === "/oauth/register" || pathname === "/oauth/authorize" ||
      pathname === "/oauth/token";
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    // `/mcp` is the Model Context Protocol endpoint for external MCP clients. The `/mcp/*` prefix
    // is forwarded too even though the backend answers only `/mcp` today: MCP's authorization flow
    // will add sibling paths, and a client probing one should reach the backend's 404 rather than
    // the single-page app's HTML, which it would try to parse as JSON.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/mcp" || url.pathname.startsWith("/mcp/") ||
        isOAuthBackendPath(url.pathname) ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return env.WORKSHOP_BACKEND.fetch(req);
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
