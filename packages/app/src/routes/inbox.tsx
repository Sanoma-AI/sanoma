import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useActor } from "../actor.ts";
import { pendingApprovals } from "../api.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Nothing, Notice, PageHeader } from "../components/common.tsx";
import { configQuery, waitingRunsQuery } from "../queries.ts";

export const Route = createFileRoute("/inbox")({
  // The config too: each approval badges the operations it covers by their effect.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(waitingRunsQuery()),
      context.queryClient.ensureQueryData(configQuery()),
    ]),
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
  const mine = pending.filter(({ approval: { approver } }) =>
    typeof approver === "string" ? approver === actor : groups.includes(approver.group),
  ).length;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title="Inbox">
        <p className="text-sm text-muted-foreground">
          {pending.length} waiting{actor ? `, ${mine} for you` : ""}
        </p>
      </PageHeader>
      {error && <Notice variant="destructive">Could not refresh approvals: {error.message}</Notice>}
      {pending.length === 0 && <Nothing title="Nothing is waiting for a decision" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map(({ run, approval }) => (
          <ApprovalCard
            key={`${run.runId}/${approval.id}`}
            runId={run.runId}
            runStatus={run.status}
            approval={approval}
            run={run}
          />
        ))}
      </div>
    </section>
  );
}
