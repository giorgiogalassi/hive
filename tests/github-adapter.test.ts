import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitHubAdapter, VcsHttpError, VcsTimeoutError } from "../src/vcs/index.js";

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, ...init });

function adapter(fetchFn: typeof fetch, timeoutMs?: number) {
  return new GitHubAdapter({ fetch: fetchFn, token: () => "tok", timeoutMs });
}

const parse = (event: string, payload: unknown) =>
  adapter(vi.fn() as unknown as typeof fetch).parseEvent(
    { "X-GitHub-Event": event },
    JSON.stringify(payload),
  );

const repository = { full_name: "o/r" };

describe("parseEvent", () => {
  it("parses pull_request opened", () => {
    expect(
      parse("pull_request", {
        action: "opened",
        repository,
        pull_request: {
          number: 5,
          title: "T",
          head: { ref: "h" },
          base: { ref: "main" },
          user: { login: "me" },
        },
      }),
    ).toEqual({
      type: "pr_opened",
      repo: "o/r",
      prNumber: 5,
      title: "T",
      headBranch: "h",
      baseBranch: "main",
      author: "me",
    });
  });

  it("parses pull_request labeled", () => {
    expect(
      parse("pull_request", {
        action: "labeled",
        repository,
        pull_request: { number: 5 },
        label: { name: "ready" },
      }),
    ).toEqual({ type: "pr_labeled", repo: "o/r", prNumber: 5, label: "ready" });
  });

  it("parses review submitted and normalizes state", () => {
    const base = {
      action: "submitted",
      repository,
      pull_request: { number: 5 },
    };
    expect(
      parse("pull_request_review", {
        ...base,
        review: { state: "CHANGES_REQUESTED", body: null, user: { login: "rev" } },
      }),
    ).toEqual({
      type: "pr_review_submitted",
      repo: "o/r",
      prNumber: 5,
      state: "changes_requested",
      body: "",
      author: "rev",
    });
    const dismissed = parse("pull_request_review", {
      ...base,
      review: { state: "DISMISSED", body: "x", user: { login: "rev" } },
    });
    expect(dismissed).toMatchObject({ state: "commented" });
    const approved = parse("pull_request_review", {
      ...base,
      review: { state: "APPROVED", body: "x", user: { login: "rev" } },
    });
    expect(approved).toMatchObject({ state: "approved" });
  });

  it("parses issue_comment with isPr", () => {
    const payload = (issue: object) => ({
      action: "created",
      repository,
      issue: { number: 3, ...issue },
      comment: { body: "hi", user: { login: "u" } },
    });
    expect(parse("issue_comment", payload({ pull_request: {} }))).toEqual({
      type: "issue_comment",
      repo: "o/r",
      number: 3,
      body: "hi",
      author: "u",
      isPr: true,
    });
    expect(parse("issue_comment", payload({}))).toMatchObject({ isPr: false });
  });

  it("parses issues labeled", () => {
    expect(
      parse("issues", {
        action: "labeled",
        repository,
        issue: { number: 9 },
        label: { name: "bug" },
      }),
    ).toEqual({ type: "issue_labeled", repo: "o/r", issueNumber: 9, label: "bug" });
  });

  it("returns null for ping, unhandled and invalid bodies", () => {
    expect(parse("ping", { zen: "x" })).toBeNull();
    expect(parse("pull_request", { action: "closed", repository, pull_request: {} })).toBeNull();
    expect(
      adapter(vi.fn() as unknown as typeof fetch).parseEvent({}, "not json"),
    ).toBeNull();
  });
});

describe("http behaviour", () => {
  it("sends token auth header and an abort signal", async () => {
    const fetchFn = vi.fn(async () => json([{ name: "a" }]));
    expect(await adapter(fetchFn as unknown as typeof fetch).hasLabel("o/r", 1, "a")).toBe(true);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("token tok");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("follows Link-header pagination in listIssues", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        json([{ number: 1, title: "a", body: null }], {
          headers: { Link: '<https://api.github.com/next>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(json([{ number: 2, title: "b", body: "x" }]));
    const issues = await adapter(fetchFn as unknown as typeof fetch).listIssues("o/r", "hive");
    expect(issues).toEqual([
      { number: 1, title: "a", body: "" },
      { number: 2, title: "b", body: "x" },
    ]);
    expect(fetchFn.mock.calls[1]?.[0]).toBe("https://api.github.com/next");
  });

  it("lists open pull requests", async () => {
    const fetchFn = vi.fn(async () =>
      json([{ number: 7, title: "t", head: { ref: "h" }, base: { ref: "m" }, user: { login: "u" } }]),
    );
    expect(await adapter(fetchFn as unknown as typeof fetch).listOpenPullRequests("o/r")).toEqual([
      { number: 7, title: "t", headBranch: "h", baseBranch: "m", author: "u" },
    ]);
  });

  it("throws VcsHttpError carrying the status on non-2xx", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 403 }));
    const err = await adapter(fetchFn as unknown as typeof fetch)
      .postComment("o/r", 1, "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VcsHttpError);
    expect((err as VcsHttpError).status).toBe(403);
  });

  it("throws VcsTimeoutError when the request exceeds the timeout", async () => {
    const fetchFn = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      adapter(fetchFn as unknown as typeof fetch, 20).getIssue("o/r", 1),
    ).rejects.toBeInstanceOf(VcsTimeoutError);
  });

  it("maps review states to provider events", async () => {
    const fetchFn = vi.fn(async () => json({}));
    const a = adapter(fetchFn as unknown as typeof fetch);
    await a.postReview("o/r", 1, "b", "changes_requested");
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ body: "b", event: "REQUEST_CHANGES" });
  });
});

describe("getIssueDependencies", () => {
  it("prefers sub-issues and deduplicates", async () => {
    const fetchFn = vi.fn(async () => json([{ number: 4 }, { number: 4 }, { number: 5 }]));
    expect(await adapter(fetchFn as unknown as typeof fetch).getIssueDependencies("o/r", 1)).toEqual([4, 5]);
  });

  it("falls back to Depends-on body parsing on 404", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(json({ number: 1, title: "t", body: "Depends-on: #2, #3\ndepends-on: #3 #9" }));
    expect(await adapter(fetchFn as unknown as typeof fetch).getIssueDependencies("o/r", 1)).toEqual([2, 3]);
  });

  it("returns [] when nothing is found", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json({ number: 1, title: "t", body: null }));
    expect(await adapter(fetchFn as unknown as typeof fetch).getIssueDependencies("o/r", 1)).toEqual([]);
  });
});

describe("getPrDiff", () => {
  it("writes diff.patch into the workdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-diff-"));
    const remote = await mkdtemp(join(tmpdir(), "hive-remote-"));
    execFileSync("git", ["init", "-q", "-b", "main", remote]);
    const rgit = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: remote, stdio: "pipe" });
    rgit("commit", "-q", "--allow-empty", "-m", "init");
    rgit("checkout", "-q", "-b", "feat");
    await (await import("node:fs/promises")).writeFile(join(remote, "a.txt"), "hello\n");
    rgit("add", "a.txt");
    rgit("commit", "-q", "-m", "add");
    rgit("checkout", "-q", "main");
    execFileSync("git", ["clone", "-q", remote, dir]);

    const fetchFn = vi.fn(async () => json({ head: { ref: "feat" }, base: { ref: "main" } }));
    const path = await adapter(fetchFn as unknown as typeof fetch).getPrDiff("o/r", 1, dir);
    expect(path).toBe(join(dir, "diff.patch"));
    expect(await readFile(path, "utf8")).toContain("+hello");
  });

  it("getPullRequest maps title, body and branches inside the adapter", async () => {
    const fetchFn = vi.fn(async () =>
      json({ number: 4, title: "t", body: null, head: { ref: "h" }, base: { ref: "m" }, user: { login: "u" } }),
    );
    expect(await adapter(fetchFn as unknown as typeof fetch).getPullRequest("o/r", 4)).toEqual({
      number: 4, title: "t", body: "", headBranch: "h", baseBranch: "m", author: "u",
    });
  });

  it("parseEvent returns null instead of throwing when required fields are missing", () => {
    expect(parse("issues", { action: "labeled", repository: { full_name: "o/r" } })).toBeNull();
    expect(parse("pull_request", { action: "opened", pull_request: { number: 1 } })).toBeNull();
    expect(parse("pull_request_review", { action: "submitted", pull_request: { number: 1 }, review: {} })).toBeNull();
    expect(parse("issue_comment", { action: "created", issue: { number: 1 }, comment: {} })).toBeNull();
  });

});
