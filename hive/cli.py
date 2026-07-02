#!/usr/bin/env python3
"""
hive — Autonomous agent orchestrator CLI.

Entry point for running Hive agents against a labelled set of GitHub issues.

Usage:
    hive run --project <label>              Execute agents on all open issues with <label>
    hive run --project <label> --repo o/r  Override the target repository
    hive deploy                             (not implemented)
    hive list                               (not implemented)
    hive remove                             (not implemented)

Repository resolution order for `hive run`:
    1. --repo flag (per-invocation override)
    2. GITHUB_REPO environment variable (CI / Docker override)
    3. git remote get-url origin (auto-detected from the current repo)

Environment variables (layered resolution — highest priority first):
    1. os.environ / shell exports  — always win; never overridden by any .env file.
    2. .env in cwd                 — per-project config (e.g. GITHUB_OWNER, GITHUB_REPO).
    3. ~/.hive/.env                — machine-level secret fallback (e.g. GITHUB_TOKEN,
                                     CLAUDE_CODE_OAUTH_TOKEN).

    The Docker / Compose consumer reads the repo-root .env via ``env_file`` and is
    unaffected by this layering — it does not call ``_load_env()``.
"""

import argparse
import importlib.resources
import os
import pathlib
import sys
import time


def _parse_dotenv(path: pathlib.Path) -> dict[str, str]:
    """Parse a ``.env`` file and return a dict of key→value pairs.

    Handles the following syntax:
    - Blank lines and lines starting with ``#`` are ignored.
    - ``KEY=VALUE`` — bare value.
    - ``KEY="VALUE"`` or ``KEY='VALUE'`` — surrounding quotes are stripped.
    - ``export KEY=VALUE`` — the leading ``export`` keyword is ignored.
    - Inline ``#`` comments are **not** stripped (values are taken verbatim after
      the ``=``), which is the safest default for token strings.

    Args:
        path: Absolute or relative path to the ``.env`` file.

    Returns:
        Mapping of environment variable names to their string values.
    """
    result: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return result
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Strip optional leading "export " keyword
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip matching surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if key:
            result[key] = value
    return result


def _load_env() -> None:
    """Apply layered ``.env`` resolution to ``os.environ``.

    Priority (highest first):

    1. **os.environ** — values already in the environment (shell exports, CI
       injections) are **never overwritten**.
    2. **cwd/.env** — per-project config that varies with the working directory
       (e.g. ``GITHUB_OWNER``, ``GITHUB_REPO``).
    3. **~/.hive/.env** — machine-level secret fallback (e.g. ``GITHUB_TOKEN``,
       ``CLAUDE_CODE_OAUTH_TOKEN``).

    Both files are optional; missing files are silently skipped.

    The Docker / Compose consumer reads the repo-root ``.env`` via ``env_file``
    in ``docker-compose.yml`` and does **not** call this function, so its
    behaviour is unchanged.
    """
    merged: dict[str, str] = {}

    # Layer 3 — machine-level fallback (loaded first → lowest file priority)
    global_env = pathlib.Path.home() / ".hive" / ".env"
    merged.update(_parse_dotenv(global_env))

    # Layer 2 — per-project overrides (loaded second → wins over Layer 3)
    cwd_env = pathlib.Path.cwd() / ".env"
    merged.update(_parse_dotenv(cwd_env))

    # Layer 1 — os.environ always wins; only inject keys that are not already set
    for key, value in merged.items():
        if key not in os.environ:
            os.environ[key] = value


def _agent_yaml(name: str) -> str:
    """Return the filesystem path to a bundled agent YAML file.

    Uses ``importlib.resources`` so the path resolves correctly whether the
    package is run from a source checkout or from a global ``pip install``.

    Args:
        name: Filename of the YAML file (e.g. ``"cody.yaml"``).

    Returns:
        Absolute path string to the YAML file inside the installed package.
    """
    return str(importlib.resources.files("hive.agents").joinpath(name))


def cmd_run(args):
    """Execute Cody and Reven agents for every open issue carrying the given label.

    Fetches all open issues with the specified label, resolves their dependency
    order using Kahn's topological sort algorithm, then runs Cody (developer
    agent) followed by Reven (reviewer agent) for each issue in order.

    Args:
        args: Parsed argparse namespace. Must contain ``project`` (str).
    """
    from hive.runner.vcs.github_adapter import GitHubAdapter
    import hive.runner.agent_runner as agent_runner

    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        print("ERROR: GITHUB_TOKEN must be set", file=sys.stderr)
        sys.exit(1)

    repo = args.repo or os.environ.get("GITHUB_REPO", "") or _detect_repo()
    if not repo:
        print(
            "ERROR: could not determine repository. Use --repo, set GITHUB_REPO, "
            "or run from inside a git repo with an 'origin' remote.",
            file=sys.stderr,
        )
        sys.exit(1)

    vcs = GitHubAdapter()
    label = args.project

    # 1. Fetch all open issues with this label
    issues = vcs.list_issues(repo, label)
    if not issues:
        print(f"No open issues found with label '{label}'")
        return

    # 2. Build dependency graph
    issue_map = {i["number"]: i for i in issues}
    deps = {}  # number -> list of numbers it depends on
    for number in issue_map:
        deps[number] = vcs.get_issue_dependencies(repo, number)

    # 3. Topological sort (Kahn's algorithm)
    in_degree = {n: 0 for n in issue_map}
    for n, blockers in deps.items():
        for b in blockers:
            if b in issue_map:
                in_degree[n] += 1

    queue = [n for n in issue_map if in_degree[n] == 0]
    order = []
    while queue:
        n = queue.pop(0)
        order.append(n)
        for m in issue_map:
            if n in deps.get(m, []):
                in_degree[m] -= 1
                if in_degree[m] == 0:
                    queue.append(m)

    if len(order) != len(issue_map):
        # Cycle detected — identify which issues are stuck and abort before
        # running any agent so no partial state is created.
        remaining = set(issue_map) - set(order)
        print(f"ERROR: Circular dependency detected among issues: {sorted(remaining)}", file=sys.stderr)
        sys.exit(1)

    # 4. Resolve agent YAML paths via importlib.resources so the CLI works
    #    correctly from a global pip install (not just a source checkout).
    cody_yaml = _agent_yaml("cody.yaml")
    reven_yaml = _agent_yaml("reven.yaml")

    # 5. Execute per issue
    for number in order:
        issue = issue_map[number]
        print(f"[hive run] Processing issue #{number}: {issue['title']}")

        context = {
            "repo_full_name": repo,
            "issue_number": number,
            "issue_title": issue["title"],
            "issue_body": issue.get("body", "") or "",
            "label": label,
            "github_token": token,
        }

        # Run Cody (developer agent)
        agent_runner.run(cody_yaml, context)

        # Poll for the PR Cody opened — branches are named agent/issue-{N}-*
        pr = _poll_for_pr(vcs, repo, number, token, interval=30, max_attempts=10)
        if not pr:
            print(f"[hive run] WARNING: No PR found for issue #{number} after polling. Skipping Reven.")
            continue

        # Run Reven (reviewer agent)
        pr_context = {
            "repo_full_name": repo,
            "pr_number": pr["number"],
            "pr_title": pr["title"],
            "pr_body": pr.get("body", "") or "",
            "head_branch": pr["head"]["ref"],
            "base_branch": pr["base"]["ref"],
            "review_body": "",
            "github_token": token,
        }
        agent_runner.run_for_pr(reven_yaml, pr_context, vcs)

        print(f"[hive run] Issue #{number} complete.")


def _detect_repo():
    """Detect the GitHub repository from the 'origin' git remote URL.

    Parses both HTTPS (https://github.com/owner/repo.git) and SSH
    (git@github.com:owner/repo.git) remote URL formats.

    Returns:
        A string in ``owner/repo`` format, or an empty string if detection fails.
    """
    import subprocess
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=True,
        )
        url = result.stdout.strip()
        # HTTPS: https://github.com/owner/repo.git
        if url.startswith("https://"):
            path = url.split("github.com/", 1)[-1].removesuffix(".git")
            if "/" in path:
                return path
        # SSH: git@github.com:owner/repo.git
        if ":" in url:
            path = url.split(":", 1)[-1].removesuffix(".git")
            if "/" in path:
                return path
    except Exception:
        pass
    return ""


def _poll_for_pr(vcs, repo, issue_number, token, interval=30, max_attempts=10):
    """Poll GitHub for an open PR whose head branch matches agent/issue-{N}-*.

    Hive agents name their branches ``agent/issue-{N}-<short-description>``, so
    this function searches open PRs for that prefix pattern.

    Args:
        vcs: VCSPort instance (unused here; raw requests used for simplicity).
        repo: Full repository name in ``owner/repo`` format.
        issue_number: Issue number whose PR is being awaited.
        token: GitHub personal access token for authentication.
        interval: Seconds to wait between polling attempts.
        max_attempts: Maximum number of polling attempts before giving up.

    Returns:
        The PR dict from the GitHub API if found, or ``None`` after exhausting
        all attempts.
    """
    import requests
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
    }
    for attempt in range(max_attempts):
        resp = requests.get(
            f"https://api.github.com/repos/{repo}/pulls",
            headers=headers,
            params={"state": "open", "per_page": 50},
        )
        if resp.ok:
            for pr in resp.json():
                if pr["head"]["ref"].startswith(f"agent/issue-{issue_number}-"):
                    return pr
        if attempt < max_attempts - 1:
            print(f"[hive run] Waiting for PR for issue #{issue_number}... ({attempt+1}/{max_attempts})")
            time.sleep(interval)
    return None


def cmd_stub(name):
    """Return a handler function that prints a not-implemented message and exits 0.

    Args:
        name: Subcommand name used in the printed message.

    Returns:
        A callable that accepts an argparse namespace and exits cleanly.
    """
    def handler(args):
        print(f"hive {name}: not implemented in this phase")
        sys.exit(0)
    return handler


def main():
    """Parse CLI arguments and dispatch to the appropriate subcommand handler."""
    # Resolve environment variables from layered .env files before any subcommand
    # reads os.environ.  Order: os.environ > cwd/.env > ~/.hive/.env.
    _load_env()

    parser = argparse.ArgumentParser(description="Hive — autonomous agent orchestrator")
    sub = parser.add_subparsers(dest="command")

    run_p = sub.add_parser("run", help="Execute agents on a labelled set of GitHub issues")
    run_p.add_argument("--project", required=True, help="GitHub issue label to target")
    run_p.add_argument(
        "--repo",
        default="",
        help="Repository in owner/repo format (overrides GITHUB_REPO and git remote detection)",
    )

    sub.add_parser("deploy", help="Deploy an agent (not implemented)")
    sub.add_parser("list", help="List deployed agents (not implemented)")
    sub.add_parser("remove", help="Remove a deployed agent (not implemented)")

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(args)
    elif args.command in ("deploy", "list", "remove"):
        cmd_stub(args.command)(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
