/** Backend-independent contracts shared by the engine and every agent backend. */

export const EVENT_SCHEMA_VERSION = 1 as const;

export type TerminalReason = "completed" | "max_turns" | "error";

export type AgentEvent =
  | { schemaVersion: 1; type: "session_started"; sessionId: string }
  /** Backend raw message; opaque to the engine, but counts as activity. */
  | { schemaVersion: 1; type: "activity"; payload: unknown }
  | {
      schemaVersion: 1;
      type: "result";
      sessionId: string;
      terminalReason: TerminalReason;
      isError: boolean;
      payload: unknown;
    }
  | { schemaVersion: 1; type: "error"; message: string; payload?: unknown };

export interface SessionRequest {
  systemPrompt: string;
  prompt: string;
  model: { name: string; maxTurns: number };
  cwd: string;
  env: Record<string, string>;
  resumeSessionId?: string;
}

export interface RunningSession {
  events: AsyncIterable<AgentEvent>;
  /** Must terminate the child process (if any) and release resources. */
  close(): Promise<void>;
  /** Child process id, when the backend has one; used to confirm it is gone. */
  pid?: number;
}

export interface AgentSession {
  start(request: SessionRequest): Promise<RunningSession>;
}

export interface WorkspacePort {
  /** Clones `repo` into a fresh working directory and returns its path. */
  clone(repo: string, token: string): Promise<string>;
  headSha(): Promise<string | null>;
  currentBranch(): Promise<string>;
  /** Commits uncommitted changes, if any. Throws when the commit fails. */
  checkpointCommit(message: string): Promise<void>;
  /** Pushes `HEAD:refs/heads/<branch>`; returns false when nothing was pushed. */
  salvage(baseSha: string | null): Promise<boolean>;
  /** Removes the working directory. */
  dispose(): Promise<void>;
}

/** What a run targets. Issue runs and PR runs build different prompts. */
export type RunTarget =
  | { kind: "issue"; repo: string; number: number; title: string; body: string }
  | {
      kind: "pr";
      repo: string;
      number: number;
      title: string;
      body: string;
      headBranch: string;
      baseBranch: string;
      reviewBody?: string;
    };
