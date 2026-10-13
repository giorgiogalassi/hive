# Failure-path checklist

Manual verification walk for the TypeScript engine rewrite (HV-12). Automated tests are
deferred for this track, so this document is the compensating control. It gates:

- HV-22: walk against `runner: claude-code`
- HV-24: walk against `runner: claude-agent-sdk`
- HV-25: deletion of the Python tree (only after both columns have no failures)

Behavioural reference is the Python runner (`hive/runner/agent_runner.py`, `hive/runner/loop.py`,
`hive/runner/main.py`) until HV-25. Where the TypeScript engine is specified to differ from
Python, the scenario says so; the specification wins over Python in those cases.

## PRD acceptance criteria covered

PRD numbering is from `.squad/prd/archive/current-20261013-092744.md`.

| PRD criterion | Summary | Scenario |
|---|---|---|
| 7 | Idle timeout terminates the iteration, child pid confirmed dead | S1 |
| 8 | max_turns: checkpoint, resume same session, stop at `max_iterations` | S3 |
| 9 | Salvage on timeout / error / exhausted iterations, with skip rules | S1, S2, S3, S4, S5 |
| 10 | Checkpoint commit before killing on idle or overall timeout | S1, S2 |
| 11 | Checkpoint failure after `max_turns`: no resume, salvage, surface failure | S4 |
| 12 | Missing/malformed `review.json` or `post_review` HTTP error: `human:review`, no salvage | S8 |
| 13 | Re-delivered `labeled` / `pull_request/opened`: no second run, no second label | S9 |
| 14 | Both credentials set: only the API key reaches the child, startup log names the kind | S10 |
| 15 | SDK without bundled binary and no override: startup fails naming the override | S11 |

PRD criteria 3 and 4 (rework cap, owner comment) are not in the 7 to 15 range but are
failure-path behaviour carried over from Python, so they are walked as S6 and S7.

## How to walk this

### Setup (once per backend)

- A scratch GitHub repo you own, with a trivial codebase and a `GITHUB_TOKEN` that has
  Contents write and Issues write (and pull requests write). Use a repo where stray branches
  and PRs are harmless.
- Env: `GITHUB_TOKEN`, `GITHUB_OWNER` (your login), `GITHUB_WEBHOOK_SECRET`, one Anthropic
  credential, a webhook on the scratch repo pointing at the receiver (needed for S6 to S9;
  S1 to S5 can also be triggered with `hive run --project <label>`).
- Record the versions in the header of the results: Hive commit SHA, Node version, Claude Code
  CLI version (`claude --version`), and for the SDK backend the SDK version and the CLI version
  it bundles.
- Test agent: copy `agents/cody.yaml` to a scratch name for each scenario and override only
  the `model` keys listed in the scenario. Keep `runner` as the backend under test
  (`claude-code` or `claude-agent-sdk`). Do not edit the committed YAMLs. Reset the copy
  between scenarios so overrides do not leak.
- Run the receiver with logs visible (`pnpm dev`, or `docker compose logs -f`). Each run also
  writes `run.log` (raw NDJSON) in its workdir; the workdir is deleted at the end of the run,
  so tail the log while the run is live if you need it.

### Conventions

- "Child pid" means the OS process the backend spawned (for the SDK backend this is the Claude
  Code subprocess it wraps, not the Node process). Capture it while the run is live with
  `pgrep -af claude` before the kill, then confirm after the kill with `ps -p <pid>` (must
  print nothing) and `pgrep -af claude` (must not list it). Also check for orphaned children
  of that pid.
- "Remote" means the scratch repo on GitHub, inspected with `git ls-remote origin` or the
  branches page.
- "Salvage comment" is the issue/PR comment posted after a salvage push. Python wording to
  match in spirit: it states that partial progress was pushed to the branch.
- "Failure comment" is the comment posted on any thrown error. Python wording: ``**Hive agent
  `<name>` encountered an error.**`` followed by "The run failed before completing. Check the
  container logs for details."
- Log line expectations quote the Python wording as the reference. TypeScript wording may
  differ; the same information must be present (agent name, iteration x/y, reason).
- Result cells: `pass`, `fail (<link to fix or issue>)`, or `n/a`. Leave blank until walked.
- A single scenario fails if any expected outcome fails. Note which one in the cell.

---

## S1. Idle timeout

Verifies PRD 7, 9, 10.

**Preconditions**
- Agent copy of `cody.yaml`; `model.idle_timeout: 20`, `timeout: 900`, `max_iterations: 1`.
- Scratch issue whose body forces silence: ask the agent to run `sleep 120` as its first
  action, after first creating and saving an uncommitted file (for example `idle-probe.txt`)
  on the agent branch. Branch must not be `main`/`master`.
- The prompt must make the agent create the branch before the sleep, so there is something to
  salvage.

**Trigger**
- Label the issue `agent:develop` (or `hive run`) and start the run.
- After the last event appears in the log, capture the child pid, then wait for 20 seconds
  with no events.

**Expected outcome**
- Log: the iteration ends because of the idle clock, naming idle timeout (Python reference:
  ``killed — idle timeout exceeded``, then ``produced no result — idle or overall timeout
  killed the process``).
- Ordering: the checkpoint commit happens before the process is closed/killed. Log shows the
  checkpoint (Python wording: ``checkpointed uncommitted changes``) before the close.
- Child pid from the capture step is not running afterwards (`ps -p <pid>` empty); no
  orphaned `claude` descendants.
- Remote: the agent branch exists and contains a checkpoint commit with `idle-probe.txt`.
- Issue has the salvage comment.
- Workdir is removed (log shows cleanup).
- Run is reported as not clean (needs salvage), not as success.

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S2. Overall timeout

Verifies PRD 9, 10.

**Preconditions**
- Agent copy of `cody.yaml`; `timeout: 30`, `model.idle_timeout: 600` (so only the wall
  clock can fire), `max_iterations: 1`.
- Scratch issue whose task keeps emitting events past 30 seconds (for example, write a file,
  then run several short `sleep 5` commands one after another so events keep arriving), with an
  uncommitted file on the agent branch.

**Trigger**
- Start the run and let it exceed 30 seconds of wall time while still emitting events.

**Expected outcome**
- Log names the overall timeout (not idle) as the reason (Python reference: ``killed —
  overall timeout exceeded``).
- Same sequence as S1: checkpoint commit first, then close, then child pid confirmed dead.
- Remote has the branch with the checkpoint commit; salvage comment posted; workdir removed.
- The idle clock did not fire: no idle-timeout log line.

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S3. max_turns resume

Verifies PRD 8, 9.

**Preconditions**
- Agent copy of `cody.yaml`; `model.max_turns: 2`, `model.max_iterations: 3`,
  `idle_timeout: 240`, `timeout: 900`.
- Scratch issue large enough that two turns cannot finish it (for example "create five files,
  commit each separately, then open a PR"), so every iteration ends at `max_turns`.

**Trigger**
- Label the issue `agent:develop` and run to completion.

**Expected outcome**
- Iteration 1 ends with terminal reason `max_turns`. Log shows the checkpoint and resume
  (Python reference: ``hit max-turns on iteration 1/3 — checkpointing and resuming
  session``).
- Remote or workdir history shows a commit with the exact message
  `checkpoint: <agent> iteration 1 (max-turns reached)`, and another for iteration 2 if there
  were uncommitted changes. If the tree was clean at the end of an iteration, no empty commit
  is created and no failure is logged.
- Iteration 2 starts with the same session id as iteration 1 (log line shows
  `resume=<id>`, or for the SDK the `resume` option). The id on iteration 3 is the same
  value. Confirm by comparing ids across the log lines or the raw NDJSON in `run.log`.
- Iteration 2 and 3 are given the prompt "Continue exactly where you left off. Do not repeat
  completed work." (visible in `run.log` or debug output).
- No iteration 4: the run stops at `model.max_iterations` (3).
- If iteration 3 still ends at `max_turns`: run is marked for salvage, branch is pushed and
  the salvage comment is posted (PRD 9: exhausted iterations still at `max_turns`).
- If it completes earlier (an iteration ends `completed`), no further iteration starts and no
  salvage is performed.
- Child pid of every finished iteration is gone before the next one starts.

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S4. Checkpoint commit failure after max_turns

Verifies PRD 11, 9.

**Preconditions**
- As S3 (`max_turns: 2`, `max_iterations: 3`).
- Make the checkpoint commit fail deterministically while the agent's own commits succeed:
  the scratch task installs a `commit-msg` hook in the clone (`.git/hooks/commit-msg`) that
  exits 1 when the message starts with `checkpoint:`. Record the method used in the result
  cell.

**Trigger**
- Run the S3 issue with the hook in place.

**Expected outcome**
- Iteration 1 ends at `max_turns`; the checkpoint commit fails.
- Log shows the failure (Python reference: ``checkpoint commit failed: <stderr>``).
- No iteration 2 starts: the log has no `resume=` line and no second child process.
- Run is marked for salvage and the failure is surfaced: the issue gets the failure
  comment and/or the salvage comment, and the run is not reported as clean.
- Salvage follows the usual rules: if HEAD moved from the post-clone SHA through the agent's
  own commits, the branch is pushed; if not, nothing is pushed (S5).
- Workdir removed.

**Note**: Python logs the failure but then still resumes. The TypeScript engine must not
resume (PRD 11). A pass on this scenario is a deliberate deviation from Python.

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S5. Salvage skipped

Verifies PRD 9 (skip rules).

Three sub-cases, each triggering a not-clean run (use an idle timeout as in S1 with
`idle_timeout: 20`, `max_iterations: 1`).

**S5a. Branch is `main`**
- Preconditions: issue instructing the agent to stay on the default branch and create an
  uncommitted file, then go silent. (Default branch name `main`; repeat with a repo whose
  default is `master` if available, otherwise mark that sub-case n/a with a reason.)
- Expected: run ends not-clean; nothing is pushed to `main` (remote `main` SHA unchanged); no
  salvage comment. The checkpoint commit in the local workdir may still exist but must not be
  pushed.

**S5b. HEAD equals the post-clone SHA**
- Preconditions: issue instructing the agent to check out a new branch, make no changes and
  no commits, then go silent.
- Expected: run ends not-clean; no new branch appears on the remote; no salvage comment.
  (The branch has no new commit, so HEAD equals the SHA recorded after clone.)

**S5c. Control: salvage performed**
- Preconditions: as S1.
- Expected: branch pushed and salvage comment posted, confirming S5a and S5b are skips and
  not a broken salvage path.

**Results**

| Sub-case | claude-code | claude-agent-sdk |
|---|---|---|
| S5a main/master | | |
| S5b HEAD == base SHA | | |
| S5c control | | |

## S6. Run 3 versus run 4 (rework cap)

Verifies PRD 3 (carried over). Related to HV-18.

**Preconditions**
- Receiver running (rework state is in memory; do not restart it mid-scenario).
- A PR from a Cody run, labelled `agent:review`, with `reven.yaml` posting reviews.
  To make the outcome deterministic, use a Reven copy told to always write
  `review.json` with `state: REQUEST_CHANGES`, or submit the reviews yourself as a different
  GitHub user.
- Note: with one token, GitHub rejects a self-review. Use a second account for the reviews, or
  walk S6 by submitting reviews from a second account and not through Reven.

**Trigger**
- Submit `changes_requested` review 1, wait for the Cody run to finish; repeat for review 2
  and review 3. Then submit a fourth `changes_requested` review.

**Expected outcome**
- Reviews 1, 2 and 3 each start exactly one Cody PR run, with the review body in the prompt.
- Review 4 starts no run, and `human:review` is applied to the PR.
- `approved` reviews start no run. `commented` reviews are ignored.
- Log for review 4 states the cap or the human-review hand-off; no Cody agent log lines
  follow it.

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S7. Owner comment versus non-owner comment

Verifies PRD 4 (carried over).

**Preconditions**
- Receiver running with `GITHUB_OWNER` set to your login; a PR as in S6 with a fresh counter
  (restart the receiver first, or use a new PR).
- A second GitHub account for the non-owner comment.

**Trigger and expected outcome**

| Step | Action | Expected |
|---|---|---|
| 1 | Owner comments on the PR before any review is posted | Ignored: no run, no label change |
| 2 | One review is posted (`changes_requested`) | Cody run 1 starts (counter 1) |
| 3 | Owner comments on the PR | Cody run starts (counter 2), comment body is in the prompt |
| 4 | Non-owner comments on the PR | Nothing happens: no run, no label, no counter change |
| 5 | Owner comments again | Cody run starts (counter 3) |
| 6 | Next `changes_requested` review | `human:review` applied, no run (cap reached; owner comments counted) |

Confirm the owner-comment events counted toward the same cap as reviews (step 6 lands on the
fourth trigger, not later).

**Results**

| claude-code | claude-agent-sdk |
|---|---|
| | |

## S8. Review-post failure

Verifies PRD 12.

Three sub-cases using a Reven copy (`output: review`) on a PR labelled `agent:review`.

**S8a. `review.json` absent**
- Preconditions: Reven copy whose prompt forbids writing `review.json` (or deletes it).
- Expected: `human:review` applied to the PR; log states `review.json` absent/malformed
  (Python reference: ``review.json absent or malformed for pr=#N: ... applying human:review
  label``); no review posted; no salvage push or salvage comment for this reason.

**S8b. `review.json` malformed**
- Preconditions: Reven copy told to write invalid JSON, and separately a file that is valid
  JSON but missing `state` or `body`. Walk both and record both.
- Expected: same as S8a.

**S8c. `post_review` HTTP error**
- Preconditions: valid `review.json` with `state: APPROVED` or `REQUEST_CHANGES`, and a PR
  authored by the same token as the reviewer, so GitHub rejects the self-review (HTTP 422).
  Alternatively, use a token that lacks pull request write.
- Expected: `human:review` applied; log shows the HTTP status; the run is not marked for
  salvage because of this (no push, no salvage comment, no failure comment from the salvage
  path); the run exits normally.
- Note: Python does not catch `requests.HTTPError` here and falls into salvage. Passing this
  sub-case is a deliberate fix of that bug.

**Results**

| Sub-case | claude-code | claude-agent-sdk |
|---|---|---|
| S8a absent | | |
| S8b malformed (invalid JSON) | | |
| S8b malformed (missing field) | | |
| S8c post_review HTTP error | | |

## S9. Re-delivered webhooks

Verifies PRD 13.

**Preconditions**
- Receiver running with a webhook on the scratch repo. Use GitHub's "Redeliver" button
  (Settings, Webhooks, Recent Deliveries) to replay payloads, or replay the saved request with
  the original signature header.

**S9a. `labeled` re-delivery while a run is in flight**
- Preconditions: Cody run that takes long enough to redeliver during it (use the S2 issue).
- Trigger: label the issue `agent:develop`; while the run is in flight, redeliver the
  `issues/labeled` delivery from GitHub.
- Expected: receiver returns 200 for both; only one run exists (one workdir, one child
  process); log shows a single drop line for the second trigger naming the key
  (repo, number, agent). After the first run finishes, a new `labeled` delivery starts a run
  normally (the key was released).

**S9b. `labeled` re-delivery for a PR run**
- Same pattern with the `agent:review` label on a PR and Reven.
- Expected: one Reven run, one review (or one `human:review` fallback), one drop line.

**S9c. `pull_request/opened` re-delivery**
- Trigger: open a PR so Hive applies `agent:review`; wait; redeliver the `pull_request/opened`
  delivery.
- Expected: exactly one `agent:review` label application; the redelivery does not call
  `applyLabel` again (label already present), starts no run by itself, and logs nothing worse
  than a debug or info line. PR timeline shows a single "added the agent:review label" event.

**Results**

| Sub-case | claude-code | claude-agent-sdk |
|---|---|---|
| S9a issue labeled | | |
| S9b PR labeled | | |
| S9c pull_request/opened | | |

## S10. Credential precedence

Verifies PRD 14.

**Preconditions**
- Both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` set in the receiver's environment
  (use harmless values only if you will inspect the env without making a real call, otherwise
  real values for a one-turn run).
- Agent copy with `max_iterations: 1`; an issue whose task is "run `env` and write the names
  only (not the values) of any variable starting with `ANTHROPIC` or `CLAUDE_CODE` to
  `env-probe.txt`". Do not commit or log the values.

**Trigger**
- Start the receiver, then run the agent.

**Expected outcome**
- Startup log (before serving, and once per process) names the credential kind in use, for
  example "API key", and never prints the value. Grep logs for the first characters of both
  secrets: no match.
- `env-probe.txt` lists `ANTHROPIC_API_KEY` and does not list `CLAUDE_CODE_OAUTH_TOKEN`.
  Alternatively inspect the child with `ps eww <pid>` (macOS) or `/proc/<pid>/environ`.
- Sub-case: unset `ANTHROPIC_API_KEY`, keep the OAuth token. Startup log names the OAuth
  kind; `env-probe.txt` lists `CLAUDE_CODE_OAUTH_TOKEN` and not `ANTHROPIC_API_KEY`.
- Sub-case: neither set. Startup log states no Anthropic credential (or the run fails with a
  clear message); no secret leaks.

Python does not strip the OAuth token when both are set; this scenario verifies new behaviour.

**Results**

| Sub-case | claude-code | claude-agent-sdk |
|---|---|---|
| Both set: only API key reaches child | | |
| Both set: startup log names kind, no value | | |
| Only OAuth token | | |
| Neither set | | |

## S11. SDK without bundled binary and no override (SDK backend only)

Verifies PRD 15.

**Preconditions**
- At least one agent in `agents/` with `runner: claude-agent-sdk` (for example
  `agents/cody-sdk.yaml`).
- Install the SDK without optional dependencies (`pnpm install --no-optional`), or delete the
  platform binary package under `node_modules/@anthropic-ai/` by hand.
- `HIVE_CLAUDE_CODE_PATH` unset.

**Trigger**
- Start the receiver (`pnpm start`) and, separately, run `hive run --project <label>`.

**Expected outcome**
- Process exits non-zero before serving any request (port 8000 is not bound).
- Error message names `HIVE_CLAUDE_CODE_PATH`.
- Sub-case: set `HIVE_CLAUDE_CODE_PATH` to the real `claude` executable: startup succeeds.
- Sub-case: set `HIVE_CLAUDE_CODE_PATH` to a non-existent path: startup fails with a message
  naming the variable.
- Sub-case: with the binary missing, remove all `runner: claude-agent-sdk` agents: startup
  succeeds (preflight only applies when such an agent is loaded).

**Results**

| Sub-case | claude-code | claude-agent-sdk |
|---|---|---|
| Missing binary, no override | n/a | |
| Override set to valid path | n/a | |
| Override set to bad path | n/a | |
| No SDK agent loaded | n/a | |

---

## Sign-off

| Gate | Walked by | Date | Hive SHA | Claude Code CLI version | SDK version (bundled CLI) | Failures open |
|---|---|---|---|---|---|---|
| HV-22 `claude-code` | | | | | n/a | |
| HV-24 `claude-agent-sdk` | | | | | | |
