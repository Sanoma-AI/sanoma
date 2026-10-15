---
name: merge-pr
description: Verify the linked issue, current review evidence, and checks before an authorized squash merge of a repository PR.
---

# Merge a PR

1. Verify user authorization to merge, reusing any already given.
2. Verify the linked issue matches the task; if missing, use [create-issue](../create-issue/SKILL.md) and link it in the PR.
3. Verify [review evidence](../create-pr/references/review.md) for the current head and base; complete missing or stale reviews.
4. Require mergeability, required approvals, and successful applicable CI for the current head. Resolve conflicts and repeat review/checks; never bypass branch rules.
5. Run `gh pr merge <number> --squash --match-head-commit <reviewed-head-sha>`; recheck if the head changes. Verify the merge and report PR/issue status; close the issue only if complete.
