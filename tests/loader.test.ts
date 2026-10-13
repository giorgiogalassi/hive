import { describe, expect, it } from "vitest";
import { agentsDir, loadAgent, parseAgent } from "../src/agents/index.js";

describe("agent loader", () => {
  it("rejects an unknown runner naming both valid runners", () => {
    const yaml = `name: x\ndescription: d\nrunner: codex\nmodel:\n  provider: p\n  name: n\n  max_turns: 1\nsystem_prompt: hi\n`;
    expect(() => parseAgent(yaml)).toThrow(/claude-code.*claude-agent-sdk/);
  });

  it.each(["cody", "reven", "issue-reviewer"])("loads agents/%s.yaml with defaults", (name) => {
    const a = loadAgent(name);
    expect(a.name).toBe(name);
    expect(a.timeout).toBeGreaterThan(0);
    expect(a.model.max_iterations).toBeGreaterThanOrEqual(1);
  });

  it("resolves the repo-root agents directory", () => {
    expect(agentsDir().endsWith("/agents")).toBe(true);
  });
});
