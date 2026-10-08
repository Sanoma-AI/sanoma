import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { mayDecide } from "@sanoma/workflows/shared";
import { Badge } from "#/components/ui/badge.tsx";
import { useActor } from "../actor.ts";
import { pendingApprovals } from "../api.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Nothing, Notice, PageHeader, toneBadge } from "../components/common.tsx";
import { waitingRunsQuery } from "../queries.ts";

export const Route = createFileRoute("/inbox")({
  loader: ({ context }) => context.queryClient.ensureQueryData(waitingRunsQuery()),
  head: () => ({ meta: [{ title: "Inbox · Sanoma" }] }),
  component: InboxPage,
});

/** Every pending approval, newest first. */
function InboxPage() {
  const { actor, groups } = useActor();
  const { data: runs, error } = useSuspenseQuery(waitingRunsQuery());
  const pending = runs
    .flatMap((run) => pendingApprovals(run).map((approval) => ({ run, approval })))
    .toSorted((a, b) => b.approval.requestedAt - a.approval.requestedAt);
  // A group approver counts only when the deployment vouches for groups: a typed name has none.
  const mine = actor
    ? pending.filter(({ approval }) => mayDecide(approval, { id: actor, groups: [...groups] })).length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Inbox">
        <Badge variant="secondary">{pending.length} waiting</Badge>
        {actor && <Badge className={toneBadge({ tone: mine ? "waiting" : "off" })}>{mine} for you</Badge>}
      </PageHeader>
      {error && <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>}
      {pending.length === 0 && <Nothing title="Nothing is waiting for a decision" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map(({ run, approval }) => (
          <ApprovalCard key={`${run.runId}/${approval.id}`} run={run} approval={approval} showRun />
        ))}
      </div>
    </div>
  );
}
