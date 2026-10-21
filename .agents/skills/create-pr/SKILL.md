---
name: create-pr
description: Create or update a pull request for this repository using its PR template and a linked GitHub issue.
---

# Create a PR

1. Link the task's existing issue; use [create-issue](../create-issue/SKILL.md) if missing.
2. Spawn a non-blocking subagent to update relevant AGENTS.md and design docs concisely, following progressive disclosure. Updates may land in a separate follow-up PR; do not wait for them or let them alter the current PR during final review.
3. Complete [pre-PR review](references/review.md), then fill in [the PR template](../../../.github/pull_request_template.md).
4. Push and create or update the PR (`gh ... --body-file <file>`). Return the PR and issue URLs. Merge authorization is separate.
