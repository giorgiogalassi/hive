import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { dispatch, toHiveEvent } from "../dispatch/index.js";
import type { DispatchDeps, HiveEvent } from "../dispatch/index.js";
import { createDispatchDeps, resolveCredentialKind } from "../runtime/deps.js";
import { GitHubAdapter } from "../vcs/github-adapter.js";
import type { VcsPort } from "../vcs/port.js";

export const DEFAULT_PORT = 8000;

export class MissingSecretError extends Error {
  constructor() {
    super("GITHUB_WEBHOOK_SECRET is not set; refusing to start the webhook receiver.");
  }
}

/** Constant-time check of an `X-Hub-Signature-256` header against the raw body. */
export function verifySignature(secret: string, rawBody: Uint8Array, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface AppOptions {
  secret: string;
  parser: Pick<VcsPort, "parseEvent">;
  dispatch: (event: HiveEvent) => Promise<unknown>;
  log?: (line: string) => void;
}

/** Verifies, parses, maps and hands off. All decisions live in dispatch. */
export function createApp(options: AppOptions): Hono {
  const log = options.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!verifySignature(options.secret, raw, c.req.header("x-hub-signature-256"))) {
      return c.text("Invalid or missing signature", 401);
    }
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let event: HiveEvent | null;
    try {
      const normalized = options.parser.parseEvent(headers, raw);
      event = normalized ? toHiveEvent(normalized) : null;
    } catch (err) {
      log(`[webhook] could not parse verified payload: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ status: "ignored" });
    }
    if (event) {
      // Respond now; the run continues after the response and must never crash the server.
      Promise.resolve()
        .then(() => options.dispatch(event))
        .catch((err: unknown) => log(`[webhook] dispatch failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return c.json({ status: "ok" });
  });

  return app;
}

export interface StartOptions {
  env?: Record<string, string | undefined>;
  port?: number;
  /** Defaults to the real deps with runMode 'background'. */
  deps?: DispatchDeps;
  log?: (line: string) => void;
  /** Defaults to @hono/node-server's serve. */
  listen?: (app: Hono, port: number) => unknown;
}

/** Starts the receiver; throws MissingSecretError when GITHUB_WEBHOOK_SECRET is unset. */
export function startWebhook(options: StartOptions = {}): { app: Hono; port: number } {
  const env = options.env ?? process.env;
  const log = options.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const secret = env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) throw new MissingSecretError();
  const port = options.port ?? Number(env["PORT"] ?? DEFAULT_PORT);
  const deps = options.deps ?? createDispatchDeps({ runMode: "background", env, log });
  const app = createApp({
    secret,
    parser: new GitHubAdapter(),
    dispatch: (event) => dispatch(event, deps),
    log,
  });
  (options.listen ?? ((a, p) => serve({ fetch: a.fetch, port: p })))(app, port);
  log(`[webhook] listening on port ${port}; anthropic credential in use: ${resolveCredentialKind(env)}`);
  return { app, port };
}
