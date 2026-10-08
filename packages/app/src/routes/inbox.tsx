import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useActor } from "../actor.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Nothing, Notice, PageHeader } from "../components/common.tsx";
import { waitingRunsQuery } from "../queries.ts";

export const Route = createFileRoute("/inbox")({
  loader: ({ context }) => context.queryClient.ensureQueryData(waitingRunsQuery()),
  head: () => ({ meta: [{ title: "Inbox · Sanoma" }] }),
  component: InboxPage,
});

/** Every pending approval, newest first. */
function InboxPage() {
  const { actor } = useActor();
  const { data: runs, error } = useSuspenseQuery(waitingRunsQuery());
  const pending = runs
    .flatMap((run) => run.approvals.filter((a) => a.status === "pending").map((approval) => ({ run, approval })))
    .toSorted((a, b) => b.approval.requestedAt - a.approval.requestedAt);
  // Names only: a group approver needs the deployment to vouch for groups, which a typed name cannot.
  const mine = pending.filter(({ approval }) => approval.approver === actor).length;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title="Inbox">
        <p className="text-sm text-muted-foreground">
          {pending.length} waiting{actor ? `, ${mine} for you` : ""}
        </p>
      </PageHeader>
      {error && <Notice tone="bad">Could not refresh approvals: {error.message}</Notice>}
      {pending.length === 0 && <Nothing title="Nothing is waiting for a decision" />}
      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map(({ run, approval }) => (
          <ApprovalCard
            key={`${run.runId}/${approval.id}`}
            runId={run.runId}
            approval={approval}
            showRun
            description={`${run.workflow}, started by ${run.startedBy?.id ?? "unknown"}`}
          />
        ))}
      </div>
    </section>
  );
}
