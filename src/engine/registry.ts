import type { RunnerKind } from "../agents/loader.js";
import type { AgentSession } from "./types.js";

export type AgentSessionFactory = () => AgentSession;

/** Maps the agent YAML `runner` value to an AgentSession factory. */
export class BackendRegistry {
  private readonly factories = new Map<string, AgentSessionFactory>();

  register(runner: RunnerKind | string, factory: AgentSessionFactory): this {
    this.factories.set(runner, factory);
    return this;
  }

  has(runner: string): boolean {
    return this.factories.has(runner);
  }

  create(runner: string): AgentSession {
    const factory = this.factories.get(runner);
    if (!factory) throw new Error(`Unknown runner: ${runner}`);
    return factory();
  }
}
