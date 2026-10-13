import type { BackendRegistry } from "../../engine/registry.js";
import { ClaudeCodeSession } from "./session.js";
import type { ClaudeCodeOptions } from "./session.js";

export { ClaudeCodeSession, buildArgs } from "./session.js";
export type { ClaudeCodeOptions } from "./session.js";

/** Registers the Claude Code CLI backend under `runner: claude-code`. */
export function registerClaudeCode(registry: BackendRegistry, options: ClaudeCodeOptions = {}): BackendRegistry {
  return registry.register("claude-code", () => new ClaudeCodeSession(options));
}
