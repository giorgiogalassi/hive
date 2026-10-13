#!/usr/bin/env node
import { Command } from "commander";
import { loadAllAgents } from "../agents/index.js";

export function buildProgram(): Command {
  const program = new Command().name("hive").description("Run AI coding agents against labelled GitHub issues.");

  program
    .command("run")
    .description("Execute agents on a labelled set of GitHub issues")
    .option("--project <label>", "issue label to process")
    .action(() => {
      console.error("hive run is not implemented yet (see HV-20).");
      process.exitCode = 1;
    });

  program
    .command("deploy")
    .description("Deploy an agent (not implemented)")
    .action(() => {
      console.error("hive deploy is not implemented yet.");
      process.exitCode = 1;
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
      console.error("hive remove is not implemented yet.");
      process.exitCode = 1;
    });

  return program;
}

await buildProgram().parseAsync(process.argv);
