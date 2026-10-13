import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HiveEvent } from "../src/dispatch/index.js";
import { GitHubAdapter } from "../src/vcs/github-adapter.js";
import { MissingSecretError, createApp, startWebhook } from "../src/webhook/server.js";

const SECRET = "s3cret";
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function setup() {
  const events: HiveEvent[] = [];
  const logs: string[] = [];
  const app = createApp({
    secret: SECRET,
    parser: new GitHubAdapter(),
    dispatch: async (e) => void events.push(e),
    log: (l) => logs.push(l),
  });
  return { app, events, logs };
}

const labeled = JSON.stringify({
  action: "labeled",
  repository: { full_name: "o/r" },
  issue: { number: 7 },
  label: { name: "agent:develop" },
});

const post = (app: ReturnType<typeof setup>["app"], body: string, headers: Record<string, string>) =>
  app.request("/webhook", { method: "POST", body, headers });

describe("webhook receiver", () => {
  it("valid signature on issues/labeled dispatches and returns 200", async () => {
    const { app, events } = setup();
    const res = await post(app, labeled, { "x-github-event": "issues", "x-hub-signature-256": sign(labeled) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([{ type: "issue_labeled", repo: "o/r", issueNumber: 7, label: "agent:develop" }]);
  });

  it("missing signature -> 401, nothing dispatched", async () => {
    const { app, events } = setup();
    const res = await post(app, labeled, { "x-github-event": "issues" });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("wrong signature -> 401, nothing dispatched", async () => {
    const { app, events } = setup();
    const res = await post(app, labeled, { "x-github-event": "issues", "x-hub-signature-256": sign(labeled, "other") });
    expect(res.status).toBe(401);
    expect(events).toEqual([]);
  });

  it("ping -> 200, nothing dispatched", async () => {
    const { app, events } = setup();
    const body = JSON.stringify({ zen: "hi" });
    const res = await post(app, body, { "x-github-event": "ping", "x-hub-signature-256": sign(body) });
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

  it("a rejecting dispatch is logged and does not fail the response", async () => {
    const logs: string[] = [];
    const app = createApp({
      secret: SECRET,
      parser: new GitHubAdapter(),
      dispatch: async () => {
        throw new Error("boom");
      },
      log: (l) => logs.push(l),
    });
    const res = await post(app, labeled, { "x-github-event": "issues", "x-hub-signature-256": sign(labeled) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs.join("\n")).toContain("boom");
  });
});

describe("startWebhook", () => {
  it("throws naming GITHUB_WEBHOOK_SECRET when unset", () => {
    expect(() => startWebhook({ env: {}, listen: () => undefined })).toThrow(MissingSecretError);
    expect(() => startWebhook({ env: {}, listen: () => undefined })).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it("logs the credential kind and listens", () => {
    const logs: string[] = [];
    let listened = 0;
    startWebhook({
      env: { GITHUB_WEBHOOK_SECRET: "x", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      log: (l) => logs.push(l),
      listen: (_a, p) => void (listened = p),
    });
    expect(listened).toBe(8000);
    expect(logs.join("\n")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("a verified payload whose parse throws is logged and answered 200 ignored", async () => {
    const logs: string[] = [];
    const app = createApp({
      secret: SECRET,
      parser: {
        parseEvent: () => {
          throw new TypeError("boom");
        },
      },
      dispatch: async () => undefined,
      log: (l) => logs.push(l),
    });
    const res = await post(app, labeled, { "x-github-event": "issues", "x-hub-signature-256": sign(labeled) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored" });
    expect(logs.some((l) => l.includes("could not parse"))).toBe(true);
  });

  it("a real adapter given a payload missing fields answers 200 ignored", async () => {
    const { app, events } = setup();
    const bad = JSON.stringify({ action: "labeled", repository: { full_name: "o/r" } });
    const res = await post(app, bad, { "x-github-event": "issues", "x-hub-signature-256": sign(bad) });
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

});
