---
name: start-task
description: Start a new implementation task in this repository with a linked GitHub issue and a dedicated Git worktree.
---

# Start a task

1. Reuse the GitHub issue for this task. If none exists, use the [create-issue skill](../create-issue/SKILL.md) first.
2. Fetch the latest default branch from `origin`. Create a branch named `task/<issue-number>-<short-slug>` and a dedicated worktree from that remote branch, using the available worktree tool or `git worktree add`. Preserve existing work; reuse this task's worktree when resuming it.
3. Report the issue URL and worktree path, then begin the requested work inside that worktree.
