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
6. After confirming the merge, fast-forward the shared main checkout and remove only this task's clean worktree with `git worktree remove <path>`. Preserve uncommitted or ignored work and other sessions' worktrees; never force removal.
7. Then drop this task's test databases if it set its own `SANOMA_TEST_DATABASE_URL` (note it before step 6): that database and every `<name>_<suffix>` one [`testDatabaseUrl`](../../../packages/sanoma/testing/README.md) made. Read the printed drops, delete any line for another worktree whose name extends this one's, then run the last line with the first; never use the plain `sanoma_test`.

   ```sh
   url=<the task's SANOMA_TEST_DATABASE_URL>; db=${url##*/}; pg=${url%/*}/postgres; f=/tmp/drops-$db.sql
   test -n "$db" -a "$db" != sanoma_test && psql "$pg" -Atc "select format('drop database %I with (force);', datname) from pg_database where datname = '$db' or starts_with(datname, '${db}_')" > "$f" && cat "$f"
   psql "$pg" -v ON_ERROR_STOP=1 -f "$f"
   ```
