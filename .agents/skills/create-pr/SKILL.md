---
name: create-pr
description: Create or update a pull request for this repository using its PR template and a linked GitHub issue.
---

# Create a PR

1. Identify the GitHub issue for this task. Every PR must link to an existing issue; if none exists, use the [create-issue skill](../create-issue/SKILL.md) first.
2. Inspect the branch diff and fill in [the PR template](../../../.github/pull_request_template.md), which owns the content and issue-linking format.
3. Push the task branch and create the PR, or update its existing PR. Use the completed template as the body (with `gh`, pass it via `--body-file`). Return the PR and issue links. Creating a PR does not authorize merging it.
