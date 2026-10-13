import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const RUNNERS = ["claude-code", "claude-agent-sdk"] as const;
export type RunnerKind = (typeof RUNNERS)[number];

export interface AgentModel {
  provider: string;
  name: string;
  max_turns: number;
  max_iterations: number;
  idle_timeout: number;
}

export interface AgentTrigger {
  type: string;
  [key: string]: unknown;
}

export interface AgentConfig {
  name: string;
  description: string;
  runner: RunnerKind;
  output?: "review";
  model: AgentModel;
  timeout: number;
  triggers: AgentTrigger[];
  system_prompt: string;
}

export class AgentConfigError extends Error {
  constructor(source: string, message: string) {
    super(`Invalid agent config ${source}: ${message}`);
    this.name = "AgentConfigError";
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string, source: string, path = key): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new AgentConfigError(source, `'${path}' must be a non-empty string`);
  }
  return v;
}

function posInt(o: Obj, key: string, fallback: number | undefined, source: string, path: string): number {
  const v = o[key] ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new AgentConfigError(source, `'${path}' must be a positive integer`);
  }
  return v;
}

/** Validate an already-parsed YAML document. `source` labels errors. */
export function validateAgent(raw: unknown, source = "<inline>"): AgentConfig {
  if (!isObj(raw)) throw new AgentConfigError(source, "document must be a mapping");

  const runner = raw["runner"];
  if (typeof runner !== "string" || !(RUNNERS as readonly string[]).includes(runner)) {
    throw new AgentConfigError(
      source,
      `unknown runner '${String(runner)}'; expected one of: ${RUNNERS.join(", ")}`,
    );
  }

  const output = raw["output"];
  if (output !== undefined && output !== "review") {
    throw new AgentConfigError(source, "'output' must be 'review' when set");
  }

  const model = raw["model"];
  if (!isObj(model)) throw new AgentConfigError(source, "'model' must be a mapping");

  const triggers = raw["triggers"] ?? [];
  if (!Array.isArray(triggers) || !triggers.every(isObj)) {
    throw new AgentConfigError(source, "'triggers' must be a list of mappings");
  }
  const parsedTriggers = triggers.map((t): AgentTrigger => ({ ...t, type: str(t, "type", source, "triggers[].type") }));

  const config: AgentConfig = {
    name: str(raw, "name", source),
    description: str(raw, "description", source),
    runner: runner as RunnerKind,
    model: {
      provider: str(model, "provider", source, "model.provider"),
      name: str(model, "name", source, "model.name"),
      max_turns: posInt(model, "max_turns", undefined, source, "model.max_turns"),
      max_iterations: posInt(model, "max_iterations", 1, source, "model.max_iterations"),
      idle_timeout: posInt(model, "idle_timeout", 300, source, "model.idle_timeout"),
    },
    timeout: posInt(raw, "timeout", 900, source, "timeout"),
    triggers: parsedTriggers,
    system_prompt: str(raw, "system_prompt", source),
  };
  if (output === "review") config.output = "review";
  return config;
}

export function parseAgent(yamlText: string, source = "<inline>"): AgentConfig {
  return validateAgent(parse(yamlText) as unknown, source);
}

/**
 * Repo-root `agents/` directory. The same relative hop works from source
 * (src/agents/) and from the built package (dist/agents/).
 */
export function agentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");
}

export function loadAgentFile(path: string): AgentConfig {
  return parseAgent(readFileSync(path, "utf8"), path);
}

export function loadAgent(name: string, dir: string = agentsDir()): AgentConfig {
  return loadAgentFile(join(dir, `${name}.yaml`));
}

export function loadAllAgents(dir: string = agentsDir()): AgentConfig[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => loadAgentFile(join(dir, f)));
}
