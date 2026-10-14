---
name: create-pr
description: Create or update a pull request for this repository using its PR template and a linked GitHub issue.
---

# Create a PR

1. Link the task's existing issue; use [create-issue](../create-issue/SKILL.md) if missing.
2. Complete [pre-PR review](references/review.md), then fill in [the PR template](../../../.github/pull_request_template.md).
3. Push and create or update the PR (`gh ... --body-file <file>`). Return the PR and issue URLs. Merge authorization is separate.
