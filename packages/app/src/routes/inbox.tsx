import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useActor } from "../actor.ts";
import { ApprovalCard } from "../components/approval.tsx";
import { Notice } from "../components/common.tsx";
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
    <section>
      <header className="page-head">
        <h1>Inbox</h1>
        <p className="muted">
          {pending.length} waiting{actor ? `, ${mine} for you` : ""}
        </p>
      </header>
      {error && <Notice tone="bad">Could not refresh approvals: {error.message}</Notice>}
      {pending.length === 0 && <Notice>Nothing is waiting for a decision.</Notice>}
      <div className="cards">
        {pending.map(({ run, approval }) => (
          <div key={`${run.runId}/${approval.id}`}>
            <p className="card-label">
              {run.workflow}, started by {run.startedBy?.id ?? "unknown"}
            </p>
            <ApprovalCard runId={run.runId} approval={approval} showRun />
          </div>
        ))}
      </div>
    </section>
  );
}
