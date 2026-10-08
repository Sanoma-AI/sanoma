import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { mayDecide } from "@sanoma/workflows/shared";
import { Badge } from "#/components/ui/badge.tsx";
import { useActor } from "../actor.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Nothing, Notice, PageHeader, pageTitle, toneBadge } from "../components/common.tsx";
import { pendingOf, waitingRunsQuery } from "../queries.ts";

export const Route = createFileRoute("/inbox")({
  loader: async ({ context }) => {
    await context.queryClient.query({ ...waitingRunsQuery(), staleTime: "static" });
  },
  staticData: { crumb: "Inbox" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: InboxPage,
});

/** Every pending approval, newest first. */
function InboxPage() {
  const { actor, groups } = useActor();
  const { data: pending, error } = useSuspenseQuery({ ...waitingRunsQuery(), select: pendingOf });
  // A group approver counts only when the deployment vouches for groups: a typed name has none.
  const mine = actor
    ? pending.filter(({ approval }) => mayDecide(approval, { id: actor, groups: [...groups] })).length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader>
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
