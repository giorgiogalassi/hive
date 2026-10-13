import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same rules as the Python `_parse_dotenv`: no inline-comment stripping, optional `export`, matching quotes stripped. */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length);
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function readDotenv(path: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export interface LayeredEnvOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  home?: string;
}

/** Precedence: process env > `<cwd>/.env` > `~/.hive/.env`. Missing files are skipped. */
export function loadLayeredEnv(options: LayeredEnvOptions = {}): Record<string, string | undefined> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const merged: Record<string, string | undefined> = {
    ...readDotenv(join(home, ".hive", ".env")),
    ...readDotenv(join(cwd, ".env")),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}
