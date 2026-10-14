# Pre-PR review

Review the complete diff against the current PR base, including docs and configuration.

- **Claude:** run `/simplify`, apply relevant changes, then `/review`.
- **Codex:** read and follow `$review-agent` (normally `~/.codex/skills/.system/review-agent/SKILL.md`) in a read-only pass; fix findings outside that pass.

If a required skill is unavailable, report it and stop before PR creation or merge.

Resolve findings, run relevant checks, commit, and review the final commit. Repeat when the head or base changes, including conflict resolutions; body-only edits need no new review.

In the PR's Review section, record environment, skills actually run, full head/base SHAs, result, and findings resolved. Before merging, verify this evidence; rerun missing, stale, or unverifiable reviews. Skill review does not replace required GitHub approval.
