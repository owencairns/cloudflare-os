#!/usr/bin/env node
// CLI harness that drives a MyoPlan OS instance over its Cap'n Web API.
//
// Usage: pnpm os-client <command> [args...] [--flags]
// See README below (or the command list in `usage()`) for the full surface.

import { createInterface } from "node:readline/promises";
import { loadDotEnv } from "./env.ts";
import * as cmds from "./commands.ts";

loadDotEnv();

function usage(): string {
  return `os-client -- drives a MyoPlan OS instance over Cap'n Web.

Env: OS_URL (default http://localhost:8787), OS_TOKEN ("username:token"),
     OS_PASSWORD (used by \`login\` if set; otherwise prompts).
     Also loads ./.os-client.env if present (gitignored; prod credentials).

Commands:
  login <username>                                  print a token as "username:token"
  whoami                                             current user + amIAdmin
  ws:list                                            list workspaces
  ws:create <title>                                  create a workspace
  ws:show <id>                                       workspace metadata + workpieces + chats
  gadget:create <wsId> <title>                       create a permanent gadget in a workspace
  code:read <wsId> <gadgetId>                        read a gadget's committed files
  code:write <wsId> <gadgetId> <chatId> <path> --file <local>
                                                      whole-file write via a chat's code stream
  code:merge <wsId> <chatId>                         accept a chat's proposed changes
  chat:new <wsId> <msg> [--model id]                 start a chat, returns chatId
  chat:send <wsId> <chatId> <msg> [--model id]        send a message on an existing chat
  chat:read <wsId> <chatId>                          read chat history
  blueprint:publish <wsId> <gadgetId> [--title t] [--desc d]
                                                      publish a gadget as a blueprint
  blueprint:install <blueprintId>                    instantiate a workspace from a blueprint
  outputs:list                                       list all workspace outputs
  rpc <wsId> <method> [jsonArg ...]                  call a gadget's own RPC method; args are JSON
  context:list [collectionId] [prefix]                list Context collections or documents
  context:search <query> [--limit n]                  full-text search Context
  context:read <collectionId> <path>                  read one Context document
  context:write <collectionId> <path> --file <md> --description <text>
                                                      write one Markdown document
  context:rpc <method> [jsonArg ...]                  call the current user's Context API
  context:export --out <file>                         export Context to a JSON backup
  context:import <file> [--mode merge|replace]        import a Context JSON backup
  admin:signups <on|off>                             toggle account signups (admin only)
`;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }

  const { positional, flags } = parseFlags(rest);
  let result: unknown;

  switch (command) {
    case "login": {
      const username = need(positional[0], "usage: os-client login <username>");
      const password = process.env.OS_PASSWORD ?? (await promptHidden(`Password for ${username}: `));
      result = await cmds.login(username, password);
      break;
    }
    case "whoami":
      result = await cmds.whoami();
      break;
    case "ws:list":
      result = await cmds.wsList();
      break;
    case "ws:create":
      result = await cmds.wsCreate(need(positional[0], "usage: os-client ws:create <title>"));
      break;
    case "ws:show":
      result = await cmds.wsShow(need(positional[0], "usage: os-client ws:show <id>"));
      break;
    case "gadget:create":
      result = await cmds.gadgetCreate(
        need(positional[0], "usage: os-client gadget:create <wsId> <title>"),
        need(positional[1], "usage: os-client gadget:create <wsId> <title>"),
      );
      break;
    case "code:read":
      result = await cmds.codeRead(
        need(positional[0], "usage: os-client code:read <wsId> <gadgetId>"),
        need(positional[1], "usage: os-client code:read <wsId> <gadgetId>"),
      );
      break;
    case "code:write":
      result = await cmds.codeWrite(
        need(positional[0], "usage: os-client code:write <wsId> <gadgetId> <chatId> <path> --file <local>"),
        need(positional[1], "usage: os-client code:write <wsId> <gadgetId> <chatId> <path> --file <local>"),
        need(positional[2], "usage: os-client code:write <wsId> <gadgetId> <chatId> <path> --file <local>"),
        need(positional[3], "usage: os-client code:write <wsId> <gadgetId> <chatId> <path> --file <local>"),
        need(flags.file, "--file <local> is required"),
      );
      break;
    case "code:merge":
      result = await cmds.codeMerge(
        need(positional[0], "usage: os-client code:merge <wsId> <chatId>"),
        need(positional[1], "usage: os-client code:merge <wsId> <chatId>"),
      );
      break;
    case "chat:new":
      result = await cmds.chatNew(
        need(positional[0], "usage: os-client chat:new <wsId> <msg> [--model id]"),
        need(positional[1], "usage: os-client chat:new <wsId> <msg> [--model id]"),
        flags.model ?? null,
      );
      break;
    case "chat:send":
      result = await cmds.chatSend(
        need(positional[0], "usage: os-client chat:send <wsId> <chatId> <msg> [--model id]"),
        need(positional[1], "usage: os-client chat:send <wsId> <chatId> <msg> [--model id]"),
        need(positional[2], "usage: os-client chat:send <wsId> <chatId> <msg> [--model id]"),
        flags.model ?? null,
      );
      break;
    case "chat:read":
      result = await cmds.chatRead(
        need(positional[0], "usage: os-client chat:read <wsId> <chatId>"),
        need(positional[1], "usage: os-client chat:read <wsId> <chatId>"),
      );
      break;
    case "blueprint:publish":
      result = await cmds.blueprintPublish(
        need(positional[0], "usage: os-client blueprint:publish <wsId> <gadgetId> [--title t] [--desc d]"),
        need(positional[1], "usage: os-client blueprint:publish <wsId> <gadgetId> [--title t] [--desc d]"),
        flags.title,
        flags.desc,
      );
      break;
    case "blueprint:install":
      result = await cmds.blueprintInstall(
        need(positional[0], "usage: os-client blueprint:install <blueprintId>"),
      );
      break;
    case "outputs:list":
      result = await cmds.outputsList();
      break;
    case "admin:signups": {
      const state = need(positional[0], "usage: os-client admin:signups <on|off>");
      if (state !== "on" && state !== "off") throw new Error("admin:signups expects 'on' or 'off'");
      result = await cmds.adminSignups(state === "on");
      break;
    }
    case "rpc": {
      const wsId = need(positional[0], "usage: os-client rpc <wsId> <method> [jsonArg ...]");
      const method = need(positional[1], "usage: os-client rpc <wsId> <method> [jsonArg ...]");
      const args = positional.slice(2).map((raw, i) => {
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`rpc arg #${i + 1} is not valid JSON: ${raw}`);
        }
      });
      result = await cmds.gadgetRpc(wsId, method, args);
      break;
    }
    case "context:rpc": {
      const method = need(positional[0], "usage: os-client context:rpc <method> [jsonArg ...]");
      const args = positional.slice(1).map((raw, i) => {
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`context:rpc arg #${i + 1} is not valid JSON: ${raw}`);
        }
      });
      result = await cmds.contextRpc(method, args);
      break;
    }
    case "context:list":
      result = await cmds.contextList(positional[0], positional[1]);
      break;
    case "context:search": {
      const rawLimit = flags.limit ?? "20";
      const limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("context:search --limit must be an integer from 1 to 100");
      }
      result = await cmds.contextSearch(
        need(positional[0], "usage: os-client context:search <query> [--limit n]"),
        limit,
      );
      break;
    }
    case "context:read":
      result = await cmds.contextRead(
        need(positional[0], "usage: os-client context:read <collectionId> <path>"),
        need(positional[1], "usage: os-client context:read <collectionId> <path>"),
      );
      break;
    case "context:write":
      result = await cmds.contextWrite(
        need(positional[0],
          "usage: os-client context:write <collectionId> <path> --file <md> --description <text>"),
        need(positional[1],
          "usage: os-client context:write <collectionId> <path> --file <md> --description <text>"),
        need(flags.file, "context:write requires --file <md>"),
        need(flags.description, "context:write requires --description <text>"),
      );
      break;
    case "context:export":
      result = await cmds.contextExport(
        need(flags.out, "usage: os-client context:export --out <file>"),
      );
      break;
    case "context:import": {
      const mode = flags.mode ?? "merge";
      if (mode !== "merge" && mode !== "replace") {
        throw new Error("context:import --mode must be 'merge' or 'replace'");
      }
      result = await cmds.contextImport(
        need(positional[0], "usage: os-client context:import <file> [--mode merge|replace]"),
        mode,
      );
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(usage());
      process.exit(1);
  }

  console.log(JSON.stringify(result, jsonReplacer, 2));
}

function need<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    console.error(message);
    process.exit(1);
  }
  return value;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  return value;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
