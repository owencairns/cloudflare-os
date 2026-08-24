// Minimal .env-style loader for ./.os-client.env (gitignored; holds prod credentials for
// https://os.myoplan.app when working against the deployed instance instead of localhost).
//
// Only supports simple KEY=VALUE lines, optional surrounding quotes, and `#` comments. Existing
// process.env values always win, so real environment variables can override the file.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ENV_FILE = join(ROOT, ".os-client.env");

export function loadDotEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  const contents = readFileSync(ENV_FILE, "utf8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
