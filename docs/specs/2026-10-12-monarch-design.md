# monarch — design spec

Date: 2026-10-12
Status: draft, awaiting review

## 1. Purpose

monarch is a Claude Code plugin that replaces the superpowers workflow for day-to-day feature development.

Goals:

- Keep superpowers-level code quality: one subagent per task, per-task code review, a final review, and tests on every behavior change.
- Cut token use substantially. Target: a typical multi-task feature costs at least 3x fewer total tokens than the same feature run through superpowers subagent-driven development.
- Reduce human intervention to one gate per feature: approving a short brief.
- Add an independent second opinion at final review by running Codex CLI alongside Claude.

Non-goals:

- Supporting harnesses other than Claude Code.
- Replacing superpowers' skill-writing skill. monarch ships its own short `debug` skill (`/monarch:debug`).
- Using Haiku. Agents use Opus by default and Sonnet for small mechanical jobs only.

## 2. Decisions

| Topic | Decision |
|---|---|
| Human gate | Approve the brief only. Everything after runs autonomously. |
| Models | Opus for planning, building, reviewing, fixing. Sonnet for scouting, running checks, shipping, and the Codex bridge. No Haiku. |
| Tests | Required for every behavior change (a test that fails without the change). Strict test-first order is not required. |
| Fix loops | Max 2 rounds per loop. After that, the item is marked blocked and reported. |
| Packaging | Plugin `monarch` in its own git repo at `~/DEV/monarch`, installed through a local marketplace. |
| Git output | Isolated worktree on a feature branch, one commit per task, pushed, PR opened, PR reviewed. |
| Orchestration | Main session writes the brief; a saved Workflow script (`workflows/build.js`) runs everything after approval. |
| Final review | Claude `pr-reviewer` and Codex run in parallel; findings are merged, single-source findings are verified. |

## 3. Flow

```
/monarch <request>                                        main session (Opus)
  1. scout (Sonnet) maps relevant code -> context map
  2. main writes the brief (goal, scope, non-goals, acceptance criteria, decisions)
     open questions: one batched AskUserQuestion, max 4 questions
  3. user approves the brief                              <- only gate
  4. main creates worktree + branch monarch/<slug>, launches Workflow
     'monarch:build' with args {brief, contextMap, base, repoChecks}

                                                          workflow (deterministic JS)
  Plan    planner (Opus) -> tasks[] + waves; tasks in one wave touch disjoint files
  Build   pipeline over tasks, respecting dependencies:
            builder (Opus): implement + tests + run targeted tests -> {status, files, tests, summary}
            task-reviewer (Opus): review task diff against acceptance checks
              fail -> findings to a new builder attempt (max 2 rounds) -> else BLOCKED
              pass -> task-reviewer commits "<type>: <task title>" (only the task's files)
  Verify  verifier (Sonnet): full tests, lint, typecheck, build
              fail -> fixer (Opus), re-verify (max 2 rounds)
  PR      shipper (Sonnet): push, gh pr create (brief, task list, assumptions in body)
  Review  parallel:
            pr-reviewer (Opus, high effort) -> findings[]
            codex-bridge (Sonnet) runs skills/codex-review/run.sh -> findings[]
          merge (plain JS): dedup by file + overlapping line range + category
            both sources -> confirmed
            one source   -> finding-verifier (Opus, high effort) keeps or drops
          blocking confirmed findings -> fixer -> verify -> push (max 2 rounds)
          shipper posts one PR comment; findings tagged [claude] / [codex] / [both]
  Report  return {pr, tasks, checks, findings, assumptions, skipped}
  5. main prints the report (about 15 lines)
```

Small requests: if the planner returns a single task, the flow is the same with one task. No separate fast path is needed.

## 4. Agents

Each agent is a file in `agents/` with `model` in its frontmatter. Each definition is at most 500 words, written as rules. Researched rule sets (see README credits) are condensed into the prompts rather than preloaded as skills, because a preloaded skill is paid on every agent spawn.

| Agent | Model | Effort | Input | Output (schema) |
|---|---|---|---|---|
| scout | Sonnet | low | request, repo | `{files: [{path, lines, why}], stack, defaultBranch, installCmd, checks: {test, lint, typecheck, build}}` |
| planner | Opus | medium | brief, context map | `{tasks: [{id, title, type, files, dependsOn, interface, acceptance, tests, exclusive}], constraints, reviewFocus, edgeCases, assumptions}` |
| builder | Opus | medium | task packet | `{status: done/failed, files, testsAdded, testsRun, summary}` |
| task-reviewer | Opus | medium | acceptance checks, task diff | `{verdict: pass/fail, findings: [{severity, file, line, problem, fix}], commit}` |
| verifier | Sonnet | low | repo check commands | `{pass, failures: [{check, shortestDecisiveLines}]}` |
| fixer | Opus | medium | findings or failures, affected files | `{status, files, summary}` |
| shipper | Sonnet | low | branch, PR body, comment body | `{pushed, prUrl, commentUrl}` |
| pr-reviewer | Opus | high | brief, full diff vs base, task list | `{findings: [...]}` |
| finding-verifier | Opus | high | one finding, relevant code | `{real: bool, reason}` |
| codex-bridge | Sonnet | low | worktree path, base, brief | `{ran: bool, skippedReason, findings: [...]}` |

Severity values: `blocking`, `major`, `minor`. A finding is actionable, and triggers a fix round, when it is `blocking` or `major`, or when its category is `correctness` or `security` at any severity (except "cannot verify" notes). Other `minor` findings are listed in the PR comment and report.

The planner also returns `edgeCases` (`{task, case, expected}`) from a fixed checklist: numeric precision, time and clocks, boundaries, invalid input, ordering and concurrency, resource growth. `build.js` appends each one to its task's acceptance checks and passes the full list to the PR reviewer. This rule came from a benchmark where a float-drift bug was rated minor and shipped unfixed.

Category values (used for dedup): `correctness`, `security`, `spec-gap`, `integration`, `tests`, `quality`.

## 5. Token rules

1. No SessionStart hook and no always-on context. Skills load only when `/monarch` or `/monarch:codex-review` runs. Superpowers must be disabled while monarch is in use.
2. Thin main session. Main reads the scout map, not source files, and sees only the final report after launch.
3. Context packets. `build.js` builds each agent prompt from parts:
   - builder: brief goal, its task, its context-map slice, interfaces of tasks it depends on. Not the full plan.
   - task-reviewer: task acceptance checks plus `git diff -- <task files>`. Opens full files only when the diff alone is not enough.
   - fixer: findings plus affected files.
   - pr-reviewer and Codex: brief, `git diff <base>...HEAD`, task list.
4. Structured returns. Every workflow agent call uses `schema`. Summaries are capped at 3 lines.
5. Short agent definitions (300 words max).
6. Effort tiers as in the agent table.
7. Tools decide pass/fail: tests, lint, typecheck, build.
8. Hard caps in code: 2 builder fix rounds per task, 2 verify rounds, 2 review rounds, 1 retry for a dead agent.

## 6. Codex review

Skill `skills/codex-review/` works both inside the workflow (through `codex-bridge`) and standalone as `/monarch:codex-review [PR number | --base <branch>]`.

`run.sh` contract:

```
run.sh start --cd <dir> --base <branch> [--brief <file>] --out <json> [--timeout <seconds>]
run.sh wait <id> [--max <seconds>]
exit 0: ran, findings written to <json>
exit 2: skipped (codex missing, not logged in); reason on stderr
exit 3: timed out; partial log kept
exit 4: still running (wait only)
```

It runs:

```
codex exec -s read-only -C <dir> \
  --output-schema findings.schema.json \
  -o <json> "<review prompt with base and brief>"
```

The command runs detached with its log at `.monarch/codex/<run>/log`. The default timeout is 900 seconds, enforced by `run.sh` itself. Because one foreground Bash call is capped at 10 minutes, `run.sh` has two modes: `run.sh start ...` launches Codex detached and prints a run id, and `run.sh wait <id> --max 540` blocks until Codex finishes or 540 seconds pass (exit 4 means still running). The bridge agent calls `start` once, then `wait` until it gets a final exit code.

`findings.schema.json` matches the Claude finding shape (`severity`, `category`, `file`, `line`, `endLine`, `problem`, `fix`). This lets the merge step treat both sources the same way.

Standalone mode returns the findings to the calling Claude session as a compact list and does not fix anything unless the user asks.

If Codex is skipped or times out, the review continues Claude-only, and the report states `codex review skipped: <reason>`.

## 7. Failure handling

| Case | Behavior |
|---|---|
| Builder fails twice | Task `BLOCKED` with last findings. Dependents skipped. Independent tasks continue. |
| Verify fails after 2 rounds | PR opens as draft, title prefixed `[monarch: checks failing]`. |
| Brief ambiguous at planning | Planner never asks. It picks the safer reading and records it in `assumptions`. Assumptions go in the PR body and the report. |
| Agent returns null | One retry. A second failure counts as blocked. |
| No test setup | Planner adds a minimal test setup as task 0, matching the stack. If that is out of scope, build/run checks are used and the report flags it. |
| No remote or `gh` not authenticated | Commits stay on the branch. Push, PR and comment are skipped. Review runs, and findings go to the report only. |
| Parallel commit hits `index.lock` | Committing agent retries up to 3 times with a short wait. |

State and resume: the Workflow journal handles resume (`resumeFromRunId`). Finished tasks are not redone. Logs go to `.monarch/` in the worktree, and `.monarch/` is added to `.git/info/exclude`.

## 8. Report format

```
PR #42 (draft: no)  branch monarch/add-rate-limit
Tasks 5/6 done, 1 blocked: T4 redis adapter (reason)
Checks: tests 48 pass, lint ok, typecheck ok
Review: 3 findings fixed, 1 open (minor) [codex]
Assumptions: ...
Skipped: none
```

## 9. Plugin layout

```
~/DEV/monarch/
  .claude-plugin/plugin.json
  .claude-plugin/marketplace.json
  commands/monarch.md
  skills/codex-review/SKILL.md
  skills/codex-review/run.sh
  skills/codex-review/findings.schema.json
  agents/scout.md planner.md builder.md task-reviewer.md verifier.md
         fixer.md shipper.md pr-reviewer.md finding-verifier.md codex-bridge.md
  workflows/build.js
  tests/
  docs/specs/
  README.md
```

The brief template lives inline in `commands/monarch.md` (no separate skill, to avoid an extra load). It has these sections: goal, scope, non-goals, acceptance criteria (checkable), decisions, open questions. Max 300 words.

## 10. Testing

- `run.sh`: shell tests with a fake `codex` on `PATH` covering success (fixture JSON), timeout, not installed, and not logged in.
- Merge and dedup logic: pure, dependency-free functions in `build.js`, extracted by a node test harness and unit tested (both-source match, line-range overlap, category mismatch, single-source routing).
- Agent schemas: a node test checks every schema is valid JSON Schema with `required` within `properties`.
- End to end: fixture repo `tests/fixture-app` (small TypeScript library with vitest). Run `/monarch "add modulo and power operations"` and check: branch created, one commit per task, tests pass, review comment produced, report printed.
- Token comparison: run the same request on the fixture with superpowers enabled, and compare total tokens from session logs. Pass bar: monarch uses at most one third of superpowers' tokens with all acceptance checks met.

## 11. Open risks

- Plugin-shipped workflow naming: the workflow is expected to resolve as `monarch:build`. If plugin namespacing differs, `commands/monarch.md` uses the name the registry reports. This is confirmed during implementation.
- Parallel builders share one worktree. Disjoint-file waves prevent edit conflicts, but shared generated files (lockfiles, snapshots) can still collide. The planner puts any task that changes dependencies or snapshots into its own wave.
- Opus-heavy agent mix limits savings to context discipline and fewer passes. The 3x target is checked by the token comparison test, not assumed.
