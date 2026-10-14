---
name: merge-pr
description: Verify the linked issue, current review evidence, and checks before an authorized squash merge of a repository PR.
---

# Merge a PR

1. Confirm the user authorized merging this PR; an instruction to create or review it is not merge authorization. Reuse authorization already given in the conversation.
2. Read the PR and verify its linked GitHub issue exists and matches the task. If absent, use [create-issue](../create-issue/SKILL.md) and update the PR using [the template](../../../.github/pull_request_template.md).
3. Verify the current head and base against the [pre-PR review requirements](../create-pr/references/review.md). Complete missing or stale reviews and resolve findings before continuing.
4. Verify mergeability, required approvals, and successful applicable CI checks for the current head. Resolve conflicts and rerun review/checks when necessary; do not bypass branch rules or merge with failed or pending checks.
5. Squash-merge the verified head (`gh pr merge <number> --squash --match-head-commit <reviewed-head-sha>`). If the head changes, repeat the verification. Confirm the PR is merged and report the PR and issue status; close the issue only when the work completes it.
