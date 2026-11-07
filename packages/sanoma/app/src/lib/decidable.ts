import type { ApprovalState, RunSummary } from "@sanoma-ai/workflows";
import { mayDecide, type PeopleResource } from "@sanoma-ai/workflows/shared";

/**
 * Of these approvals, the pending ones `actor` may decide; none while the page knows no name.
 * One decided, rejected or withdrawn takes no decision. A group approver counts only when the
 * deployment vouches for groups: a typed name has none. One on a run `actor` started only while
 * nobody else in `people` (the config's resources) could decide it (`mayDecide`).
 */
export const decidableBy =
  (actor: string | null | undefined, groups: readonly string[], people: readonly PeopleResource[]) =>
  <E extends { run: Pick<RunSummary, "startedBy">; approval: Pick<ApprovalState, "approver" | "status"> }>(
    entries: E[],
  ): E[] =>
    actor
      ? entries.filter(
          ({ run, approval }) =>
            approval.status === "pending" &&
            mayDecide(approval, { id: actor, groups: [...groups] }, { actor: run.startedBy }, people),
        )
      : [];
