---
name: codex-review
description: Run an independent Codex CLI code review of a branch or GitHub PR in the background and bring its findings back into this Claude session. Use for "codex review", "get a second opinion from codex", or /monarch:codex-review [PR number | --base <branch>].
argument-hint: "[PR number | --base <branch>]"
---

Codex reviews; you relay. Do not review the code yourself unless asked.

Script: `run.sh` in this skill's directory.

1. Target:
   - PR number given: `gh pr view <n> --json baseRefName,headRefName`. If the current branch is not the PR head, run `git fetch origin pull/<n>/head:monarch-pr-<n>` and `git worktree add .claude/worktrees/pr-<n> monarch-pr-<n>`, and review there. Base is `origin/<baseRefName>`.
   - `--base <branch>` given: review the current directory against that branch.
   - Nothing given: current directory against the default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, else `main`).
2. Start: `run.sh start --cd <dir> --base <base>`. Add `--brief <file>` if a `.monarch/brief.md` or PR description is available (write the PR body to `.monarch/pr-brief.md` first).
   - Exit 2: tell the user why Codex is unavailable (stderr) and stop.
3. Wait in the background: run `run.sh wait <run dir> --max 1200` with `run_in_background: true`, tell the user Codex is reviewing (log: `<run dir>/log`), and continue with whatever else they ask. Do not poll.
4. When it completes:
   - Exit 0: stdout is `{"findings": [...]}`. Print one line per finding, most severe first: `<severity> <file>:<line> (<category>): <problem> Fix: <fix>`. Then one line with counts.
   - Exit 3 or 1: report the reason and the log path.
5. Do not change code. Offer to verify and fix the blocking/major findings.
