import type { RunSummary } from "@sanoma/workflows";
import { ApprovalCard, Notice } from "../components.tsx";
import { usePoll } from "../lib.ts";

/** Every pending approval across the recent runs, newest first. */
export function InboxPage({ actor }: { actor: string }) {
  const { data: runs, error, reload } = usePoll<RunSummary[]>("/api/runs?limit=50");
  const pending = (runs ?? [])
    .flatMap((run) => run.approvals.filter((a) => a.status === "pending").map((approval) => ({ run, approval })))
    .toSorted((a, b) => b.approval.requestedAt - a.approval.requestedAt);
  const mine = pending.filter(({ approval }) => approval.approver === actor).length;

  return (
    <section>
      <header className="page-head">
        <h1>Inbox</h1>
        {runs && (
          <p className="muted">
            {pending.length} waiting, {mine} for you
          </p>
        )}
      </header>
      {error && <Notice tone="bad">Could not load approvals: {error}</Notice>}
      {runs && pending.length === 0 && <Notice>Nothing is waiting for a decision.</Notice>}
      <div className="cards">
        {pending.map(({ run, approval }) => (
          <div key={`${run.runId}/${approval.id}`}>
            <p className="card-label">
              {run.workflow}, started by {run.startedBy?.id ?? "unknown"}
            </p>
            <ApprovalCard runId={run.runId} approval={approval} onDecided={reload} showRun />
          </div>
        ))}
      </div>
    </section>
  );
}
