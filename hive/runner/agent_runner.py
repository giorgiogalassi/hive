"""
agent_runner.py — Core agent execution module for the Hive orchestration system.

Responsible for loading an agent's YAML configuration, cloning the target GitHub
repository into a temporary workspace, invoking the appropriate AI CLI runner
(Claude Code or OpenAI Codex), and cleaning up after execution completes.
"""

import json
import logging
import os
import select
import shutil
import subprocess
import tempfile
import threading
import time

import yaml

from hive.runner.vcs.port import VCSPort

logger = logging.getLogger(__name__)


def run(yaml_path: str, context: dict) -> None:
    """Execute an agent against a GitHub issue using the configuration in *yaml_path*.

    This is the main entry point for agent execution. It performs three stages:
    1. Load the agent's YAML config to determine its name, system prompt, model, and
       runner type (``claude-code`` or ``codex``).
    2. Clone the target repository into a fresh temporary directory so the agent has
       a clean, isolated workspace to read and modify files.
    3. Invoke the appropriate CLI runner, stream its output to a log file, then tear
       down the temporary workspace regardless of success or failure.

    Args:
        yaml_path: Absolute path to the agent's YAML configuration file.
        context: Dictionary of GitHub event metadata containing the keys
            ``repo_full_name``, ``issue_number``, ``issue_title``, ``issue_body``,
            ``label``, and ``github_token``.
    """
    with open(yaml_path) as f:
        config = yaml.safe_load(f)

    agent_name = config.get("name", "agent")
    system_prompt = config.get("system_prompt", "")
    model_cfg = config.get("model", {})
    runner_type = config.get("runner", "claude-code")

    logger.info("[%s] starting — runner=%s issue=#%s repo=%s",
                agent_name, runner_type, context["issue_number"], context["repo_full_name"])

    # Create a unique temporary directory scoped to this agent run so that
    # concurrent agents never share or overwrite each other's files.
    workdir = tempfile.mkdtemp(prefix=f"hive-{agent_name}-")
    logger.info("[%s] workdir=%s", agent_name, workdir)

    needs_salvage = False
    base_sha = None
    try:
        logger.info("[%s] cloning %s", agent_name, context["repo_full_name"])
        _clone_repo(context["repo_full_name"], context["github_token"], workdir)
        logger.info("[%s] clone done", agent_name)
        base_sha = _git_head_sha(workdir)

        # Dispatch to the runner specified in the agent YAML. Each runner wraps a
        # different AI CLI tool with its own prompt-formatting conventions.
        timeout = config.get("timeout", 900)

        if runner_type == "claude-code":
            needs_salvage = _invoke_claude_cli(system_prompt, model_cfg, context, workdir, agent_name, timeout)
        elif runner_type == "codex":
            _invoke_codex_cli(system_prompt, model_cfg, context, workdir, agent_name, timeout)
        else:
            raise ValueError(f"Unknown runner: {runner_type}")

        logger.info("[%s] run complete", agent_name)
    except Exception:
        logger.exception("[%s] run failed", agent_name)
        needs_salvage = True
        _post_failure_comment(context, agent_name)
    finally:
        # If the agent didn't finish cleanly, push whatever it managed to commit
        # before the workspace is discarded — the last chance to keep partial
        # progress instead of silently losing it (see _salvage_branch).
        if needs_salvage:
            try:
                _salvage_branch(workdir, context, agent_name, base_sha)
            except Exception:
                logger.exception("[%s] salvage attempt failed", agent_name)

        # Always remove the temporary workspace to avoid disk accumulation,
        # even if the agent raised an exception during execution.
        shutil.rmtree(workdir, ignore_errors=True)
        logger.info("[%s] workdir cleaned up", agent_name)


def run_for_pr(yaml_path: str, context: dict, vcs: VCSPort) -> None:
    """Execute an agent against a GitHub pull request using the config in *yaml_path*.

    This is the entry point for PR-based agent runs, used by both Reven (review
    output) and Cody (rework commits). It follows the same three-stage lifecycle
    as :func:`run` but fetches the PR diff and builds a PR-specific user message.

    Steps:
    1. Load the agent's YAML config.
    2. Create a fresh temporary workspace.
    3. Clone the target repository into that workspace.
    4. Fetch the PR diff via ``vcs.get_pr_diff`` — writes ``diff.patch`` to
       the workdir and returns its path.
    5. Build a PR-specific user message and invoke the configured CLI runner.
    6. If ``output: review`` is set in the YAML, read ``review.json`` from the
       workdir and post the review via ``vcs.post_review``; on failure, apply the
       ``human:review`` label and log the error without propagating.
    7. Always clean up the temporary workspace.

    The YAML ``output`` field:
        - ``output: review`` — agent is expected to write ``review.json`` with
          ``state`` and ``body`` keys after the run.
        - Absent (default) — agent is a Cody-style rework run; ``review.json``
          is ignored.

    Args:
        yaml_path: Absolute path to the agent's YAML configuration file.
        context: Dictionary of PR event metadata. Required keys:
            ``repo_full_name``, ``pr_number``, ``pr_title``, ``pr_body``,
            ``head_branch``, ``base_branch``, ``review_body``, ``github_token``.
        vcs: VCSPort implementation used to fetch the diff and post review output.
    """
    with open(yaml_path) as f:
        config = yaml.safe_load(f)

    agent_name = config.get("name", "agent")
    system_prompt = config.get("system_prompt", "")
    model_cfg = config.get("model", {})
    runner_type = config.get("runner", "claude-code")

    repo = context["repo_full_name"]
    pr_number = context["pr_number"]

    logger.info(
        "[%s] starting PR run — runner=%s pr=#%s repo=%s",
        agent_name, runner_type, pr_number, repo,
    )

    workdir = tempfile.mkdtemp(prefix=f"hive-{agent_name}-pr-")
    logger.info("[%s] workdir=%s", agent_name, workdir)

    needs_salvage = False
    base_sha = None
    try:
        logger.info("[%s] cloning %s", agent_name, repo)
        _clone_repo(repo, context["github_token"], workdir)
        logger.info("[%s] clone done", agent_name)

        diff_path = vcs.get_pr_diff(repo, pr_number, workdir)
        logger.info("[%s] diff written to %s", agent_name, diff_path)
        base_sha = _git_head_sha(workdir)

        user_message = _build_pr_user_message(context)
        timeout = config.get("timeout", 900)

        if runner_type == "claude-code":
            needs_salvage = _invoke_claude_cli(
                system_prompt, model_cfg, context, workdir, agent_name, timeout,
                user_message=user_message,
            )
        elif runner_type == "codex":
            _invoke_codex_cli(
                system_prompt, model_cfg, context, workdir, agent_name, timeout,
                user_message=user_message,
            )
        else:
            raise ValueError(f"Unknown runner: {runner_type}")

        if config.get("output") == "review":
            review_path = os.path.join(workdir, "review.json")
            _handle_review_output(vcs, repo, pr_number, review_path, agent_name)

        logger.info("[%s] PR run complete", agent_name)
    except Exception:
        logger.exception("[%s] PR run failed", agent_name)
        needs_salvage = True
    finally:
        if needs_salvage:
            try:
                _salvage_branch(workdir, context, agent_name, base_sha)
            except Exception:
                logger.exception("[%s] salvage attempt failed", agent_name)

        shutil.rmtree(workdir, ignore_errors=True)
        logger.info("[%s] workdir cleaned up", agent_name)


def _clone_repo(repo_full_name: str, token: str, workdir: str) -> None:
    """Clone a GitHub repository into *workdir* using token-based authentication.

    Embeds the GitHub token directly in the HTTPS URL so that ``git clone`` can
    authenticate without requiring a pre-configured credential helper.

    Args:
        repo_full_name: Repository identifier in ``owner/repo`` format.
        token: A GitHub personal access token or installation token with read access.
        workdir: Existing directory where the repository contents will be cloned.

    Raises:
        RuntimeError: If ``git clone`` exits with a non-zero status code, wrapping
            the stderr output for easier diagnosis.
    """
    url = f"https://x-access-token:{token}@github.com/{repo_full_name}.git"
    result = subprocess.run(
        ["git", "clone", url, "."],
        cwd=workdir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git clone failed: {result.stderr}")

    # Set identity unconditionally so checkpoint commits (see _checkpoint_commit)
    # can land even if the agent is killed before it runs its own git-config step.
    subprocess.run(["git", "config", "user.email", "agent@hive.local"], cwd=workdir, check=False)
    subprocess.run(["git", "config", "user.name", "Hive Agent"], cwd=workdir, check=False)


def _git_head_sha(workdir: str) -> str | None:
    """Return the current HEAD commit SHA in *workdir*, or ``None`` if unavailable."""
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=workdir, capture_output=True, text=True
    )
    return result.stdout.strip() if result.returncode == 0 else None



def _invoke_claude_cli(
    system_prompt: str,
    model_cfg: dict,
    context: dict,
    workdir: str,
    agent_name: str,
    timeout: int = 900,
    user_message: str | None = None,
) -> bool:
    """Invoke the Claude Code CLI inside *workdir* with the given system prompt.

    Runs the CLI in a bounded loop rather than a single shot: each iteration is
    capped by ``model.max_turns`` (a per-iteration safety valve, not a hard kill
    for the whole task). If an iteration ends because it hit that cap, any
    uncommitted work is checkpointed (see :func:`_checkpoint_commit`) and the
    next iteration resumes the same Claude session via ``--resume``, up to
    ``model.max_iterations`` (default 1, i.e. today's single-shot behaviour).
    A separate idle timeout (``model.idle_timeout``, default 300s) kills a
    stalled iteration without waiting for the overall *timeout*, since a stuck
    agent produces no output long before ``timeout`` would elapse.

    The prompt is sent via stdin (``-p -``) to avoid shell argument-length
    limits and escaping issues with long issue bodies. Output streams to
    ``run.log`` inside the workdir and to the Python logger in real time via
    ``--output-format stream-json``, which also surfaces the structured
    ``session_id`` / ``terminal_reason`` needed to drive the resume loop.

    Args:
        system_prompt: The agent's behavioural instructions, sourced from its YAML.
        model_cfg: Dictionary from the YAML ``model`` block; the ``name`` key selects
            the Claude model (defaults to ``claude-sonnet-4-6``).
        context: GitHub event metadata dict — see :func:`run` for expected keys.
        workdir: Path to the cloned repository workspace.
        agent_name: Human-readable agent identifier used in log prefixes.
        timeout: Maximum seconds to wait for a single iteration to complete.
        user_message: Pre-built user prompt string. When ``None`` (default), the
            message is constructed from *context* via :func:`_build_user_message`.
            Pass an explicit value for PR-based runs that require a different format.

    Returns:
        ``True`` if the run did not reach a clean completion (killed by the idle
        or overall timeout, or exhausted ``max_iterations`` while still hitting
        the per-iteration turn cap) — signalling the caller should attempt to
        salvage whatever was committed. ``False`` on a clean finish.
    """
    model_name = model_cfg.get("name", "claude-sonnet-4-6")
    if user_message is None:
        user_message = _build_user_message(context)

    max_turns = model_cfg.get("max_turns", 40)
    max_iterations = model_cfg.get("max_iterations", 1)
    idle_timeout = model_cfg.get("idle_timeout", 300)

    env = {**os.environ, "GITHUB_TOKEN": context["github_token"]}
    prefix = f"[{agent_name}][claude]"
    log_path = os.path.join(workdir, "run.log")

    session_id = None
    prompt = user_message
    final_result = None

    with open(log_path, "w") as log_file:
        for iteration in range(1, max_iterations + 1):
            cmd = [
                "claude",
                "--print",
                "--dangerously-skip-permissions",
                "--model", model_name,
                "--max-turns", str(max_turns),
                "--output-format", "stream-json",
                "--verbose",
                "--system-prompt", system_prompt,
                "-p", "-",
            ]
            if session_id:
                cmd += ["--resume", session_id]

            logger.info(
                "%s invoking — model=%s iteration=%d/%d%s log=%s",
                prefix, model_name, iteration, max_iterations,
                f" resume={session_id}" if session_id else "", log_path,
            )
            log_file.write(f"\n----- iteration {iteration}/{max_iterations} -----\n")
            log_file.flush()

            final_result = _run_claude_streaming(
                cmd, workdir, prompt, env, timeout, idle_timeout, log_file, prefix
            )
            session_id = (final_result or {}).get("session_id", session_id)

            hit_turn_cap = bool(final_result) and final_result.get("terminal_reason") == "max_turns"
            if hit_turn_cap and iteration < max_iterations:
                logger.warning(
                    "%s hit max-turns on iteration %d/%d — checkpointing and resuming session",
                    prefix, iteration, max_iterations,
                )
                _checkpoint_commit(workdir, agent_name, iteration)
                prompt = "Continue exactly where you left off. Do not repeat completed work."
                continue

            break

    if final_result is None:
        logger.error("%s produced no result — idle or overall timeout killed the process", prefix)
        return True
    if final_result.get("is_error"):
        logger.error(
            "%s finished with an error — terminal_reason=%s",
            prefix, final_result.get("terminal_reason"),
        )
        return True

    logger.info("%s exited cleanly", prefix)
    return False


def _run_claude_streaming(
    cmd: list[str],
    cwd: str,
    input_text: str,
    env: dict,
    timeout: int,
    idle_timeout: int,
    log_file,
    prefix: str,
) -> dict | None:
    """Run *cmd* as a subprocess, killing it if it goes *idle_timeout* seconds
    without producing output (this catches a genuinely stuck agent far sooner
    than waiting for the *timeout* wall-clock cap). Streams each NDJSON line
    from ``--output-format stream-json`` to *log_file* and the Python logger
    as it arrives, and returns the parsed final ``type: result`` event.

    Returns:
        The parsed ``result`` event dict, or ``None`` if the process was killed
        before emitting one (idle timeout, overall timeout, or a crash).
    """
    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        bufsize=1,
    )
    # Write stdin from a separate thread: writing it inline before reading stdout
    # can deadlock on a large prompt if the child fills its stdout buffer before
    # we've finished writing (mirrors what subprocess.run's input= does internally).
    def _feed_stdin():
        try:
            proc.stdin.write(input_text)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threading.Thread(target=_feed_stdin, daemon=True).start()

    overall_deadline = time.monotonic() + timeout
    idle_deadline = time.monotonic() + idle_timeout
    result_payload = None

    try:
        while True:
            now = time.monotonic()
            wait = min(idle_deadline, overall_deadline) - now
            if wait <= 0:
                reason = "idle timeout" if idle_deadline <= overall_deadline else "overall timeout"
                logger.warning("%s killed — %s exceeded", prefix, reason)
                proc.kill()
                proc.wait()
                return result_payload

            ready, _, _ = select.select([proc.stdout], [], [], wait)
            if not ready:
                continue  # deadlines re-checked at the top of the loop

            line = proc.stdout.readline()
            if line == "":
                break  # EOF — process finished on its own

            log_file.write(line)
            log_file.flush()
            idle_deadline = time.monotonic() + idle_timeout

            stripped = line.strip()
            if not stripped:
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                continue

            if event.get("type") == "result":
                result_payload = event
            else:
                logger.info("%s %s", prefix, stripped)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()

    return result_payload


def _checkpoint_commit(workdir: str, agent_name: str, iteration: int) -> None:
    """Commit any uncommitted changes in *workdir* so progress survives a
    resume — and, if the run never gets further, is still there for
    :func:`_salvage_branch` to push instead of being lost with the workdir.
    """
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=workdir, capture_output=True, text=True
    )
    if not status.stdout.strip():
        return
    subprocess.run(["git", "add", "-A"], cwd=workdir, check=False)
    result = subprocess.run(
        ["git", "commit", "-m", f"checkpoint: {agent_name} iteration {iteration} (max-turns reached)"],
        cwd=workdir, capture_output=True, text=True,
    )
    if result.returncode == 0:
        logger.info("[%s] checkpointed uncommitted changes after iteration %d", agent_name, iteration)
    else:
        logger.warning("[%s] checkpoint commit failed: %s", agent_name, result.stderr.strip())


def _salvage_branch(workdir: str, context: dict, agent_name: str, base_sha: str | None) -> None:
    """Push whatever commits exist on the checked-out branch in *workdir*, even
    though the agent never reached its own push step. Best-effort, called from
    the caller's ``finally`` block right before the workdir is deleted — the
    last chance to keep partial progress instead of discarding it silently.
    """
    branch_result = subprocess.run(
        ["git", "branch", "--show-current"], cwd=workdir, capture_output=True, text=True
    )
    branch = branch_result.stdout.strip()
    if not branch or branch in ("main", "master"):
        return

    head_sha = _git_head_sha(workdir)
    if not head_sha or head_sha == base_sha:
        return  # nothing new to salvage

    token = context.get("github_token")
    repo = context.get("repo_full_name")
    if not (token and repo):
        return

    push_url = f"https://x-access-token:{token}@github.com/{repo}.git"
    result = subprocess.run(
        ["git", "push", push_url, f"HEAD:refs/heads/{branch}"],
        cwd=workdir, capture_output=True, text=True,
    )
    if result.returncode != 0:
        logger.warning("[%s] could not salvage branch %s: %s", agent_name, branch, result.stderr.strip())
        return

    logger.info("[%s] salvaged partial progress — pushed %s", agent_name, branch)
    number = context.get("issue_number") or context.get("pr_number")
    if number:
        _post_comment(
            context,
            number,
            agent_name,
            f"**Hive agent `{agent_name}` did not finish**, but partial progress was pushed to "
            f"`{branch}` before the run ended. Review and continue manually if useful.",
        )


def _invoke_codex_cli(
    system_prompt: str,
    model_cfg: dict,
    context: dict,
    workdir: str,
    agent_name: str,
    timeout: int = 900,
    user_message: str | None = None,
) -> None:
    """Invoke the OpenAI Codex CLI inside *workdir* with the given system prompt.

    Unlike the Claude runner, the Codex CLI does not accept a separate
    ``--system-prompt`` flag, so the system prompt and user message are merged into
    a single string separated by a Markdown horizontal rule before being passed via
    stdin. All output is handled in the same way as :func:`_invoke_claude_cli`.

    Args:
        system_prompt: The agent's behavioural instructions, sourced from its YAML.
        model_cfg: Dictionary from the YAML ``model`` block; the ``name`` key selects
            the Codex model (defaults to ``o4-mini``).
        context: GitHub event metadata dict — see :func:`run` for expected keys.
        workdir: Path to the cloned repository workspace.
        agent_name: Human-readable agent identifier used in log prefixes.
        timeout: Maximum seconds to wait for the CLI process to complete.
        user_message: Pre-built user prompt string. When ``None`` (default), the
            message is constructed from *context* via :func:`_build_user_message`.
            Pass an explicit value for PR-based runs that require a different format.
    """
    model_name = model_cfg.get("name", "o4-mini")
    if user_message is None:
        user_message = _build_user_message(context)
    # Codex receives one combined prompt because it has no separate system-prompt
    # flag; the horizontal rule visually separates instructions from user content.
    full_prompt = f"{system_prompt}\n\n---\n\n{user_message}"

    cmd = [
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model", model_name,
        "-",  # read prompt from stdin
    ]

    env = {**os.environ, "GITHUB_TOKEN": context["github_token"]}
    prefix = f"[{agent_name}][codex]"

    log_path = os.path.join(workdir, "run.log")
    logger.info("%s invoking — model=%s log=%s", prefix, model_name, log_path)
    with open(log_path, "w") as log_file:
        result = subprocess.run(
            cmd,
            cwd=workdir,
            input=full_prompt,
            stdout=log_file,
            stderr=log_file,
            env=env,
            timeout=timeout,
            text=True,
        )

    with open(log_path) as f:
        for line in f:
            logger.info("%s %s", prefix, line.rstrip())

    if result.returncode != 0:
        logger.error("%s exited with code %d", prefix, result.returncode)
    else:
        logger.info("%s exited cleanly", prefix)


def _post_failure_comment(context: dict, agent_name: str) -> None:
    issue = context.get("issue_number")
    if not issue:
        return
    body = (
        f"**Hive agent `{agent_name}` encountered an error.**\n\n"
        "The run failed before completing. Check the container logs for details."
    )
    _post_comment(context, issue, agent_name, body)


def _post_comment(context: dict, number: int, agent_name: str, body: str) -> None:
    """Post *body* as a comment on issue/PR *number* via the GitHub REST API.

    Works for both issues and PRs — GitHub treats PRs as issues for the
    comments endpoint. Best-effort: failures are logged, never raised.
    """
    token = context.get("github_token", "")
    repo = context.get("repo_full_name", "")
    if not (token and repo):
        return
    try:
        subprocess.run(
            [
                "curl", "-s", "-X", "POST",
                "-H", f"Authorization: token {token}",
                "-H", "Accept: application/vnd.github.v3+json",
                f"https://api.github.com/repos/{repo}/issues/{number}/comments",
                "-d", f'{{"body": {json.dumps(body)}}}',
            ],
            timeout=15,
            check=False,
        )
    except Exception:
        logger.warning("[%s] could not post comment", agent_name)


def _build_user_message(context: dict) -> str:
    """Build the user-facing prompt that describes the GitHub issue to the agent.

    Formats the repository name, issue number, issue title, and issue body into a
    plain-text message and appends two lines of environment context so the agent
    knows where the token lives and that the repo is pre-cloned.

    Args:
        context: GitHub event metadata dict containing at minimum the keys
            ``repo_full_name``, ``issue_number``, ``issue_title``, and
            ``issue_body``.

    Returns:
        A multi-line string ready to be piped into an AI CLI runner via stdin.
    """
    return (
        f"Repository: {context['repo_full_name']}\n"
        f"Issue #{context['issue_number']}: {context['issue_title']}\n\n"
        f"{context['issue_body']}\n\n"
        f"GitHub token is available in the environment variable GITHUB_TOKEN.\n"
        f"The repository has already been cloned to your working directory."
    )


def _build_pr_user_message(context: dict) -> str:
    """Build the user-facing prompt that describes a GitHub pull request to the agent.

    Includes the PR title, body, head/base branches, a reference to the diff
    patch file already written to the workdir, and optionally the review body
    from a previous Reven pass (for Cody rework runs).

    Args:
        context: PR event metadata dict containing ``repo_full_name``,
            ``pr_number``, ``pr_title``, ``pr_body``, ``head_branch``,
            ``base_branch``, ``review_body``, and ``github_token``.

    Returns:
        A multi-line string ready to be piped into an AI CLI runner via stdin.
    """
    review_section = ""
    if context.get("review_body"):
        review_section = f"\n{context['review_body']}\n"

    return (
        f"Repository: {context['repo_full_name']}\n"
        f"PR #{context['pr_number']}: {context['pr_title']}\n\n"
        f"{context['pr_body']}\n\n"
        f"Head branch: {context['head_branch']}\n"
        f"Base branch: {context['base_branch']}\n"
        f"Diff: see diff.patch in your working directory.\n"
        f"{review_section}\n"
        f"GitHub token is available in the environment variable GITHUB_TOKEN.\n"
        f"The repository has already been cloned to your working directory."
    )


def _handle_review_output(
    vcs: VCSPort,
    repo: str,
    pr_number: int,
    review_path: str,
    agent_name: str,
) -> None:
    """Post review output from ``review.json`` or apply the ``human:review`` fallback.

    Attempts to read ``{workdir}/review.json`` written by a Reven run. If the
    file is present and contains valid JSON with ``state`` and ``body`` keys,
    it calls ``vcs.post_review`` to submit the review on GitHub. Otherwise it
    logs the failure and applies the ``human:review`` label so a human is
    notified. Errors from either path are logged but never re-raised so that
    the caller's cleanup always runs.

    Args:
        vcs: VCSPort implementation used to post the review or apply the label.
        repo: Full repository identifier in ``owner/repo`` form.
        pr_number: Pull request number.
        review_path: Absolute path to the expected ``review.json`` file.
        agent_name: Human-readable agent name used in log prefixes.
    """
    try:
        with open(review_path) as f:
            data: dict = json.load(f)

        # Validate that the required keys are present before making any API call.
        if "state" not in data or "body" not in data:
            raise ValueError(
                f"review.json is missing required keys 'state' and/or 'body': {list(data.keys())}"
            )

        vcs.post_review(repo, pr_number, data["body"], data["state"])
        logger.info("[%s] review posted for pr=#%d state=%s", agent_name, pr_number, data["state"])

    except (FileNotFoundError, json.JSONDecodeError, ValueError, KeyError) as exc:
        logger.error(
            "[%s] review.json absent or malformed for pr=#%d: %s — applying human:review label",
            agent_name, pr_number, exc,
        )
        try:
            vcs.apply_label(repo, pr_number, "human:review")
            logger.info("[%s] applied human:review label to pr=#%d", agent_name, pr_number)
        except Exception:
            logger.exception(
                "[%s] could not apply human:review label to pr=#%d", agent_name, pr_number
            )
