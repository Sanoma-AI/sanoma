---
name: start-task
description: Start implementation or investigation from current main, using an issue and worktree for changes.
---

# Start a task

1. Before implementation or investigation, fetch `origin/main` and fast-forward the shared `main` checkout with `git pull --ff-only origin main`. Preserve local work: never stash or reset; if the checkout cannot fast-forward safely, investigate from a separate worktree at `origin/main`.
2. For implementation, reuse the task's issue or use [create-issue](../create-issue/SKILL.md). Create a worktree under `.claude/worktrees/<name>` with branch `task/<issue-number>-<short-slug>` from `origin/main`; make changes there, never in the shared main checkout. Read-only investigation needs no issue or task branch.
3. When resuming a task, fetch main and inspect upstream changes; reuse its worktree and integrate relevant updates before continuing. Report the issue and worktree when created.
