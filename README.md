# monarch

A Claude Code plugin for autonomous feature development. It aims for the code quality of superpowers' subagent-driven development at a fraction of the tokens, with one human gate per feature.

## How it works

`/monarch <what to build>`

In headless mode (`claude -p`), use the full name `/monarch:monarch <what to build>`. The short form is not expanded there.

1. A Sonnet **scout** maps the relevant code and the repo's check commands.
2. The main session writes a brief of at most 300 words: goal, scope, non-goals, acceptance criteria, decisions. Questions it cannot settle from the code are asked in one batch.
3. **You approve the brief.** This is the only gate.
4. A deterministic Workflow (`monarch:build`) takes over in an isolated worktree on branch `monarch/<slug>`:
   - **planner** (Opus) splits the brief into tasks, each with files, interfaces, acceptance checks and tests. It also lists edge cases (numeric precision, time and clocks, boundaries, invalid input, concurrency, resource growth, compatibility with existing callers); each one becomes an acceptance check of its task.
   - Each task gets its own **builder** (Opus) and **task-reviewer** (Opus). A failed review goes back to a fresh builder, max 2 rounds. Passed tasks are committed one commit per task. Blocked tasks are stashed and reported. Tasks that touch disjoint files run in parallel.
   - **verifier** (Sonnet) runs the full checks; **fixer** (Opus) repairs failures, max 2 rounds.
   - **shipper** (Sonnet) pushes and opens the PR (draft if checks fail).
   - **Dual final review**: **pr-reviewer** (Opus) and **Codex CLI** review the whole PR in parallel. Findings both reported are confirmed; single-source actionable findings go to a **finding-verifier** (Opus). Actionable means blocking or major, or any correctness or security finding regardless of severity. Confirmed findings are fixed, re-verified and re-checked, max 2 rounds. Results are posted as a PR comment tagged `[claude]`, `[codex]` or `[both]`.
5. You get a report of about 15 lines.

## Codex review on its own

`/monarch:codex-review [PR number | --base <branch>]` starts Codex in the background, keeps the session free, and relays its findings when done. Requires `codex` installed and logged in (`codex login`). If Codex is unavailable, `/monarch` continues with the Claude review only and says so in the report.

## Where the token savings come from

- No SessionStart hook and no always-on skills. Nothing loads until `/monarch` runs.
- The main session reads the scout map, not the code, and sees only the final report.
- Each agent gets a packet built for it (its task, its context slice, the task diff), not the plan and conversation history.
- One reviewer per task instead of two. Plans contain interfaces and acceptance checks, not code.
- Every agent returns small structured JSON. Agent definitions are under 300 words.
- Loop caps live in code.

## Debugging

`/monarch:debug <symptom>` runs a repro-first root-cause process: red repro, shrink, ranked falsifiable hypotheses, one change at a time, regression test, stop after 3 failed fixes.

## Install

```
claude plugin marketplace add ~/DEV/monarch
claude plugin install monarch@monarch-local
claude plugin disable superpowers@claude-plugins-official   # optional, avoids its session-start injection
```

## Test

```
npm test                       # workflow helpers, simulated end-to-end flow, codex runner
tests/e2e-setup.sh             # fixture repo for a real /monarch run
```

## Benchmark

`bench/` compares monarch, superpowers and plain Claude Code on the same tasks. Each arm runs headless on a fresh copy of `bench/fixture` (a small task API with planted bugs), with only its own plugin enabled and no MCP servers.

```
bench/run-arm.sh <ratelimit|bugfix> <monarch|superpowers|plain> <out-dir> [tag]   # one run, writes meta.json (cost, time, turns)
bench/eval.sh <out-dir>/<task>-<arm>                                       # own tests + hidden acceptance tests, writes score.json
```

The hidden tests in `bench/hidden/` are never visible to the arms. Code quality beyond the hidden tests is judged by a blind reviewer on anonymized copies, plus a Codex review per run.

Design: `docs/specs/2026-10-12-monarch-design.md`.

## Credits

Several agent rules are condensed or paraphrased from these sources:

- [obra/superpowers](https://github.com/obra/superpowers) (MIT): task-reviewer evidence rules, test-quality gates (`writing-good-tests.md`), planner constraints/review focus/interfaces, the 3-failed-fixes stop rule.
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `code-review` (Apache-2.0): pr-reviewer false-positive exclusions and confidence threshold.
- [garrytan/gstack](https://github.com/garrytan/gstack) `review/checklist.md` (MIT): completeness, race, untrusted-input and gate-integrity checks.
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) `pr-review-toolkit` silent-failure-hunter (Apache-2.0): silent-failure patterns.
- [trailofbits/skills](https://github.com/trailofbits/skills) `fp-check` and `differential-review` (CC-BY-SA-4.0): ideas behind the finding-verifier gates and risk-area review, rewritten in original wording.
- [mattpocock/skills](https://github.com/mattpocock/skills) `diagnosing-bugs` and `to-tickets` (MIT): debug skill process, thin slices, expand–contract.
- [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (MIT): changed lines trace to the task.
