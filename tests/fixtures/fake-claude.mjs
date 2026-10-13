#!/usr/bin/env node
// Fake `claude` CLI: behaviour chosen by FAKE_CLAUDE_MODE; argv/stdin recorded to FAKE_CLAUDE_OUT.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_CLAUDE_MODE ?? "complete";
const out = process.env.FAKE_CLAUDE_OUT;
const sid = process.env.FAKE_CLAUDE_SESSION ?? "sess-1";
const line = (o) => process.stdout.write(`${typeof o === "string" ? o : JSON.stringify(o)}\n`);

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (out) appendFileSync(out, `${JSON.stringify({ argv: process.argv.slice(2), stdinLength: stdin.length, pid: process.pid })}\n`);
  line({ type: "system", subtype: "init", session_id: sid });
  line({ type: "assistant", session_id: sid, message: { content: [] } });
  line("not json at all");
  process.stderr.write("warning on stderr\n");
  if (mode === "max_turns") {
    line({ type: "result", subtype: "error_max_turns", terminal_reason: "max_turns", is_error: true, session_id: sid });
  } else if (mode === "subtype_only") {
    line({ type: "result", subtype: "error_max_turns", is_error: true, session_id: sid });
  } else if (mode === "complete") {
    line({ type: "result", subtype: "success", terminal_reason: "completed", is_error: false, session_id: sid });
  } else if (mode === "crash") {
    process.exit(3);
  } else if (mode === "hang" || mode === "hang_ignore_term") {
    if (mode === "hang_ignore_term") process.on("SIGTERM", () => undefined);
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    if (out) appendFileSync(out, `${JSON.stringify({ grandchild: child.pid })}\n`);
    setInterval(() => undefined, 1000);
  }
});
