import logging
import os
import shutil
import subprocess
import tempfile

import yaml

logger = logging.getLogger(__name__)


def run(yaml_path: str, context: dict) -> None:
    with open(yaml_path) as f:
        config = yaml.safe_load(f)

    agent_name = config.get("name", "agent")
    system_prompt = config.get("system_prompt", "")
    model_cfg = config.get("model", {})
    runner_type = config.get("runner", "claude-code")

    logger.info("[%s] starting — runner=%s issue=#%s repo=%s",
                agent_name, runner_type, context["issue_number"], context["repo_full_name"])

    workdir = tempfile.mkdtemp(prefix=f"hive-{agent_name}-")
    logger.info("[%s] workdir=%s", agent_name, workdir)

    try:
        logger.info("[%s] cloning %s", agent_name, context["repo_full_name"])
        _clone_repo(context["repo_full_name"], context["github_token"], workdir)
        logger.info("[%s] clone done", agent_name)

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
        shutil.rmtree(workdir, ignore_errors=True)
        logger.info("[%s] workdir cleaned up", agent_name)


def _clone_repo(repo_full_name: str, token: str, workdir: str) -> None:
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
    model_name = model_cfg.get("name", "o4-mini")
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
    return (
        f"Repository: {context['repo_full_name']}\n"
        f"Issue #{context['issue_number']}: {context['issue_title']}\n\n"
        f"{context['issue_body']}\n\n"
        f"GitHub token is available in the environment variable GITHUB_TOKEN.\n"
        f"The repository has already been cloned to your working directory."
    )
