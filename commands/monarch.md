---
description: Build a feature autonomously. You approve one short brief; per-task subagents build, review, verify, open a PR, and run a dual Claude + Codex review.
argument-hint: "<what to build>"
---

Request: $ARGUMENTS

This command replaces brainstorming, writing-plans and subagent-driven-development for this request. Do not invoke superpowers skills while running it. Keep your own context thin: do not read source files yourself unless the scout map leaves a decision open.

## 1. Scout

Run `git rev-parse --show-toplevel` (stop if not a git repo). Then dispatch one `monarch:scout` agent with the request. Ask it to return, as JSON: `files` (path, lines, why), `stack`, `defaultBranch`, `installCmd`, and `checks` {test, lint, typecheck, build} (null when absent).

## 2. Brief

From the request and the scout map, write a brief of at most 300 words:

```
# <Title>
Goal: <one or two sentences: the outcome and who it is for>
Scope: <bullets: what changes>
Non-goals: <bullets: what will not change>
Acceptance criteria: <bullets, each checkable by a test or command>
Decisions: <bullets: choices you made that the user might not expect>
```

If something cannot be decided from the request or the code and a wrong guess would waste the run, ask it in ONE AskUserQuestion call (max 4 questions, multiple choice, recommended option first). Ask nothing you can decide yourself; record those under Decisions instead.

Show the brief and ask: "Approve the brief? (yes / changes)". Stop and wait. This is the only gate. On changes, revise and ask again.

## 3. Launch (after approval)

1. Pick `slug` (kebab-case, max 5 words). `base` = scout's `defaultBranch`. Branch `monarch/<slug>`.
2. If an `origin` remote exists: `git fetch origin <base>` and use `origin/<base>` as the start point; else `<base>`.
3. `git worktree add -b monarch/<slug> <repo>/.claude/worktrees/monarch-<slug> <start point>`.
4. Append `.monarch/` and `.claude/worktrees/` to `<repo>/.git/info/exclude` if missing.
5. Write the brief to `<worktree>/.monarch/brief.md`.
6. If the scout gave `installCmd` and dependencies are not present in the worktree, run it there.
7. Find the Codex script: `ls "${CLAUDE_PLUGIN_ROOT}/skills/codex-review/run.sh" 2>/dev/null || ls ~/.claude/plugins/cache/*/monarch/*/skills/codex-review/run.sh | tail -1`.
8. Call the Workflow tool with `name: "monarch:build"` and `args`:
   `{brief, briefPath, goal, contextMap, worktree, base, branch, title, checks, codexScript}`
   (contextMap = the scout JSON; paths absolute; goal = the brief's Goal line).

Do not watch or narrate the workflow. Wait for its completion notification.

## 4. Report

Print at most 15 lines from the workflow result:

```
PR <url> (draft: yes/no)  branch <branch>
Tasks <done>/<total>; blocked/skipped: <id title: reason (stash name)>
Checks: <each check ok/fail>
Review: <fixed> fixed, <open> open, <minor> minor, <dropped> dropped as false; <codex status>
Open: <severity where: problem [source]> (one line each)
Assumptions: <list>
```

If `ok` is false, print the stage and error, and stop. Leave the worktree in place; tell the user its path. Do not merge anything.
