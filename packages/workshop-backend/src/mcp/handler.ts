// The `/mcp` endpoint: the glue between the transport-level MCP server and this instance.
//
// The handler runs *in process*, in the same Worker invocation as the request. It authenticates
// through the same path as the Cap'n Web endpoint next door -- a `PublicApiImpl` built per request,
// then `authenticate()` -- and every tool then works through the resulting `AuthenticatedApi` and
// the stubs it hands out. No tool touches a Durable Object namespace directly. The practical
// consequence is that an MCP client is exactly as privileged as the user whose credential it
// carries, with no second implementation of any permission check.

import { McpServer } from "@gadgets/mcp-server/server";
import { handleStreamableHttp } from "@gadgets/mcp-server/transport";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { authenticateMcpRequest } from "./auth.js";
import { authorizeTool, MCP_TOOLS, type McpToolContext } from "./tools.js";
import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.mcp");

/** The path the router forwards here, and the only one this handler answers. */
export const MCP_PATH = "/mcp";

const SERVER_INSTRUCTIONS =
    "This server drives a MyoPlan OS instance. The model to hold in mind: a **workspace** is the " +
    "container; it holds **gadgets** (apps, each with its own files and git history) and **chats** " +
    "(threads where an agent works). Code changes are never written straight to mainline -- " +
    "write_file adds to a chat's proposed changes, and accept_changes commits them. read_files " +
    "always reads committed mainline code, so a file written but not yet accepted will not appear " +
    "there. Agent turns started by send_message run asynchronously; poll rather than waiting.";

/**
 * Built once per isolate. The server is stateless -- the tool table plus dispatch -- so there is
 * nothing per-request to keep in it; everything request-scoped travels in the context.
 */
const server = new McpServer<McpToolContext>({
  name: "myoplan-os",
  title: "MyoPlan OS",
  version: "1.0.0",
  instructions: SERVER_INSTRUCTIONS,
  tools: MCP_TOOLS,
  // ==> THE SCOPE SEAM <== see tools.ts `authorizeTool`.
  authorize: authorizeTool,
});

/** What the handler needs from the surrounding fetch handler to authenticate a request. */
export type McpHandlerDeps = {
  /**
   * Runs `PublicApi.authenticate(token)` for this request. Supplied by server.ts so this module
   * doesn't have to know how a `PublicApiImpl` is constructed (or hold the `ExecutionContext` and
   * `Env` that construction needs).
   */
  authenticateSessionToken: (token: string) => Promise<AuthenticatedApi>;
};

/**
 * Handles a request to `/mcp`.
 *
 * Order matters: authentication comes first, so an unauthenticated request gets the 401 +
 * `WWW-Authenticate` challenge that starts OAuth discovery without ever entering JSON-RPC. A
 * `CORS` preflight is the one exception -- a browser sends it without credentials by definition, so
 * it is answered before auth (by the transport, which owns the CORS headers).
 */
export async function handleMcpRequest(
    req: Request, url: URL, deps: McpHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    // No context is needed to answer a preflight, and no tool can run from one.
    return handleStreamableHttp(req, server, undefined as unknown as McpToolContext);
  }

  let auth = await authenticateMcpRequest(req, url, deps);
  if (!auth.ok) return auth.response;

  let ctx: McpToolContext = { principal: auth.principal, api: auth.principal.api };

  try {
    return await handleStreamableHttp(req, server, ctx);
  } catch (error) {
    // handleStreamableHttp turns per-request failures into JSON-RPC errors itself, so reaching here
    // means the transport itself broke. Log it -- there is no other record -- and answer plainly.
    logger.warn("mcp request failed", { event: "mcp.request.failed", error });
    return new Response("Internal error handling MCP request.", { status: 500 });
  }
}
