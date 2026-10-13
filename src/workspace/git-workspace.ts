import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspacePort } from "../engine/types.js";

const execFileAsync = promisify(execFile);

interface GitResult {
  stdout: string;
  stderr: string;
}

/** Default WorkspacePort: shells out to `git` inside a fresh temp directory. */
export class GitWorkspace implements WorkspacePort {
  private dir: string | undefined;
  private token = "";
  private repo = "";

  constructor(
    private readonly agentName: string,
    private readonly host = "github.com",
  ) {}

  private get cwd(): string {
    if (!this.dir) throw new Error("workspace not cloned");
    return this.dir;
  }

  private async git(args: string[]): Promise<GitResult> {
    return execFileAsync("git", args, { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
  }

  private remoteUrl(): string {
    return `https://x-access-token:${this.token}@${this.host}/${this.repo}.git`;
  }

  async clone(repo: string, token: string): Promise<string> {
    this.repo = repo;
    this.token = token;
    this.dir = await mkdtemp(join(tmpdir(), `hive-${this.agentName}-`));
    try {
      await this.git(["clone", this.remoteUrl(), "."]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err);
      // Never leak the token embedded in the URL.
      throw new Error(`git clone failed: ${stderr.split(token).join("***")}`);
    }
    // Unconditional so checkpoint commits land even if the agent is killed early.
    await this.git(["config", "user.email", "agent@hive.local"]);
    await this.git(["config", "user.name", "Hive Agent"]);
    return this.dir;
  }

  async headSha(): Promise<string | null> {
    try {
      return (await this.git(["rev-parse", "HEAD"])).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.git(["branch", "--show-current"])).stdout.trim();
  }

  async checkpointCommit(message: string): Promise<void> {
    const status = await this.git(["status", "--porcelain"]);
    if (!status.stdout.trim()) return;
    await this.git(["add", "-A"]);
    await this.git(["commit", "-m", message]);
  }

  async salvage(_baseSha: string | null): Promise<boolean> {
    const branch = await this.currentBranch();
    if (!branch) return false;
    try {
      await this.git(["push", this.remoteUrl(), `HEAD:refs/heads/${branch}`]);
      return true;
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? String(err);
      throw new Error(`git push failed: ${stderr.split(this.token).join("***")}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
    this.dir = undefined;
  }
}
