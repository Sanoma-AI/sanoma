# Pre-PR review

Review the complete change against the PR's current base branch, including documentation and configuration changes.

- **Claude:** run `/simplify`, apply relevant changes, then run `/review` on the resulting diff.
- **Codex:** use the installed `$review-agent` skill (normally `~/.codex/skills/.system/review-agent/SKILL.md`). Read its instructions and perform its read-only review of the base-branch diff; keep fixes outside the review pass.

If a required skill is unavailable, report the missing skill and stop before creating or merging the PR; do not label a substitute check as that skill's review.

Resolve actionable findings, run the relevant checks, commit the final changes, and review that commit. Repeat after any subsequent commit, including conflict resolutions. A PR-body edit alone does not require another review.

Record evidence in the PR template's Review section: agent environment, skills actually run, full reviewed head SHA, base SHA used for comparison, result, and how findings were resolved. Never mark a skill as run without performing it.

Before merging, verify that the evidence covers the current head and current base. If either changed, or evidence is missing or unverifiable, run this procedure and update the PR evidence before merging. This skill review is separate from any GitHub approval required by branch rules.
