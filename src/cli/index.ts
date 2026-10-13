#!/usr/bin/env node
import { Command } from "commander";
import { loadAllAgents } from "../agents/index.js";
import { createDispatchDeps } from "../runtime/deps.js";
import { loadLayeredEnv } from "./env.js";
import { REPO_GUIDANCE, resolveRepo } from "./repo.js";
import { runBatch } from "./run.js";

export function buildProgram(): Command {
  const program = new Command().name("hive").description("Run AI coding agents against labelled GitHub issues.");

  program
    .command("run")
    .description("Execute agents on a labelled set of GitHub issues")
    .requiredOption("--project <label>", "issue label to process")
    .option("--repo <owner/repo>", "repository (default: GITHUB_REPO, then the origin remote)")
    .action(async (opts: { project: string; repo?: string }) => {
      // Layered env: process env > ./.env > ~/.hive/.env. Applied to process.env for the VCS adapter.
      const env = loadLayeredEnv();
      for (const [k, v] of Object.entries(env)) if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
      if (!env["GITHUB_TOKEN"]) {
        console.error("ERROR: GITHUB_TOKEN must be set");
        process.exitCode = 1;
        return;
      }
      const repo = resolveRepo(opts.repo, env);
      if (!repo) {
        console.error(REPO_GUIDANCE);
        process.exitCode = 1;
        return;
      }
      const deps = createDispatchDeps({ runMode: "await", env });
      process.exitCode = await runBatch({ repo, label: opts.project, deps });
    });

  program
    .command("deploy")
    .description("Deploy an agent (not implemented)")
    .action(() => {
      console.log("hive deploy: not implemented in this phase");
    });

  program
    .command("list")
    .description("List available agents")
    .action(() => {
      for (const a of loadAllAgents()) console.log(`${a.name}\t${a.runner}\t${a.description}`);
    });

  program
    .command("remove")
    .description("Remove a deployed agent (not implemented)")
    .argument("[name]", "agent name")
    .action(() => {
      console.log("hive remove: not implemented in this phase");
    });

  return program;
}

await buildProgram().parseAsync(process.argv);
