"""
agent_runner.py — Core agent execution module for the Hive orchestration system.

Responsible for loading an agent's YAML configuration, cloning the target GitHub
repository into a temporary workspace, invoking the appropriate AI CLI runner
(Claude Code or OpenAI Codex), and cleaning up after execution completes.
"""

import logging
import os
import shutil
import subprocess
import tempfile

import yaml

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

    try:
        logger.info("[%s] cloning %s", agent_name, context["repo_full_name"])
        _clone_repo(context["repo_full_name"], context["github_token"], workdir)
        logger.info("[%s] clone done", agent_name)

        # Dispatch to the runner specified in the agent YAML. Each runner wraps a
        # different AI CLI tool with its own prompt-formatting conventions.
        if runner_type == "claude-code":
            _invoke_claude_cli(system_prompt, model_cfg, context, workdir, agent_name)
        elif runner_type == "codex":
            _invoke_codex_cli(system_prompt, model_cfg, context, workdir, agent_name)
        else:
            raise ValueError(f"Unknown runner: {runner_type}")

        logger.info("[%s] run complete", agent_name)
    except Exception:
        logger.exception("[%s] run failed", agent_name)
    finally:
        # Always remove the temporary workspace to avoid disk accumulation,
        # even if the agent raised an exception during execution.
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



def _invoke_claude_cli(
    system_prompt: str,
    model_cfg: dict,
    context: dict,
    workdir: str,
    agent_name: str,
) -> None:
    """Invoke the Claude Code CLI inside *workdir* with the given system prompt.

    Passes the user message via stdin (``-p -``) to avoid shell argument-length
    limits and escaping issues with long issue bodies. All stdout and stderr output
    from the CLI is redirected to ``run.log`` inside the workdir and then replayed
    line-by-line to the Python logger so it appears in the server's log stream.

    Args:
        system_prompt: The agent's behavioural instructions, sourced from its YAML.
        model_cfg: Dictionary from the YAML ``model`` block; the ``name`` key selects
            the Claude model (defaults to ``claude-sonnet-4-6``).
        context: GitHub event metadata dict — see :func:`run` for expected keys.
        workdir: Path to the cloned repository workspace.
        agent_name: Human-readable agent identifier used in log prefixes.
    """
    model_name = model_cfg.get("name", "claude-sonnet-4-6")
    user_message = _build_user_message(context)

    cmd = [
        "claude",
        "--print",
        "--dangerously-skip-permissions",
        "--model", model_name,
        "--system-prompt", system_prompt,
        "-p", "-",  # read prompt from stdin to avoid arg-length/escaping issues
    ]

    # Inject the GitHub token so the agent can authenticate API calls and git
    # operations without relying on a pre-configured environment.
    env = {**os.environ, "GITHUB_TOKEN": context["github_token"]}
    prefix = f"[{agent_name}][claude]"

    log_path = os.path.join(workdir, "run.log")
    logger.info("%s invoking — model=%s log=%s", prefix, model_name, log_path)
    with open(log_path, "w") as log_file:
        result = subprocess.run(
            cmd,
            cwd=workdir,
            input=user_message,  # prompt via stdin
            stdout=log_file,
            stderr=log_file,
            env=env,
            timeout=300,
            text=True,
        )

    # Stream the captured log back through the Python logger so all agent output
    # is visible in the server's centralised log without opening the file manually.
    with open(log_path) as f:
        for line in f:
            logger.info("%s %s", prefix, line.rstrip())

    if result.returncode != 0:
        logger.error("%s exited with code %d", prefix, result.returncode)
    else:
        logger.info("%s exited cleanly", prefix)


def _invoke_codex_cli(
    system_prompt: str,
    model_cfg: dict,
    context: dict,
    workdir: str,
    agent_name: str,
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
    """
    model_name = model_cfg.get("name", "o4-mini")
    # Codex receives one combined prompt because it has no separate system-prompt
    # flag; the horizontal rule visually separates instructions from user content.
    full_prompt = f"{system_prompt}\n\n---\n\n{_build_user_message(context)}"

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
            timeout=300,
            text=True,
        )

    with open(log_path) as f:
        for line in f:
            logger.info("%s %s", prefix, line.rstrip())

    if result.returncode != 0:
        logger.error("%s exited with code %d", prefix, result.returncode)
    else:
        logger.info("%s exited cleanly", prefix)


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
