import type { ApprovalState, RunSummary } from "@sanoma-ai/workflows";
import { mayDecide, type PeopleResource } from "@sanoma-ai/workflows/shared";

/**
 * Of these approvals, those `actor` may decide; none while the page knows no name. A group
 * approver counts only when the deployment vouches for groups: a typed name has none. One on a
 * run `actor` started only while nobody else in `people` (the config's resources) could decide it
 * (`mayDecide`).
 */
export const decidableBy =
  (actor: string | null | undefined, groups: readonly string[], people: readonly PeopleResource[]) =>
  <E extends { run: Pick<RunSummary, "startedBy">; approval: Pick<ApprovalState, "approver"> }>(entries: E[]): E[] =>
    actor
      ? entries.filter(({ run, approval }) =>
          mayDecide(approval, { id: actor, groups: [...groups] }, { actor: run.startedBy }, people),
        )
      : [];
