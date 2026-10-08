import type { LedgerRecord } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { approverName } from "../../api.ts";
import { ApprovalCard } from "../../components/approval.tsx";
import { DecisionBadge, EffectBadge, Expandable, Notice, RunStatusBadge, When } from "../../components/common.tsx";
import { runQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/$id")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.id)),
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Sanoma` }] }),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice tone="bad">No run {Route.useParams().id}.</Notice>,
});

function RunPage() {
  const { id } = Route.useParams();
  const { data, error } = useSuspenseQuery(runQuery(id));
  const { run, ledger, ledgerError, approvals } = data;
  const titles = new Map(approvals.map((a) => [a.id, a.title]));
  return (
    <section>
      <header className="page-head">
        <h1>
          {run.workflow} <RunStatusBadge status={run.status} />
        </h1>
      </header>
      {error && <Notice tone="bad">Could not refresh: {error.message}</Notice>}
      <dl className="facts">
        <dt>Started by</dt>
        <dd>{run.startedBy?.id ?? "unknown"}</dd>
        <dt>Started</dt>
        <dd>
          <When at={run.createdAt} />
        </dd>
        <dt>Run id</dt>
        <dd>
          <code>{run.runId}</code>
        </dd>
        {run.error && (
          <>
            <dt>Error</dt>
            <dd className="error-text">{run.error}</dd>
          </>
        )}
      </dl>

      <div className="split">
        <div>
          <h2>Ledger</h2>
          {ledger === null && <Notice>This config has no ledger store, so there is no record to show.</Notice>}
          {ledgerError && <Notice tone="bad">Could not read the ledger: {ledgerError}</Notice>}
          {ledger && ledger.length === 0 && !ledgerError && <Notice>Nothing recorded yet.</Notice>}
          {ledger && ledger.length > 0 && (
            <ol className="timeline">
              {ledger.map((record) => (
                <LedgerRow key={record.id} record={record} titles={titles} />
              ))}
            </ol>
          )}
        </div>
        <aside>
          <h2>Approvals</h2>
          {approvals.length === 0 && <Notice>None asked for.</Notice>}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} runId={run.runId} approval={approval} />
          ))}
        </aside>
      </div>
    </section>
  );
}

/** One ledger record: what happened, when, and its details. */
function LedgerRow({ record, titles }: { record: LedgerRecord; titles: Map<string, string> }) {
  const title = (approval: string) => titles.get(approval) ?? approval;
  let kind = "";
  let body: ReactNode;
  let tone = "";
  switch (record.type) {
    case "run.started":
      kind = "started";
      body = (
        <>
          <p>Started by {record.actor.id}</p>
          <Expandable label="Input" value={record.input} />
        </>
      );
      break;
    case "op.called":
      kind = "called";
      tone = record.error ? "bad" : "";
      body = (
        <>
          <p className="row">
            <code>{record.op}</code> <EffectBadge effect={record.effect} /> <DecisionBadge decision={record.decision} />
            <span className="muted">
              {record.durationMs} ms{record.attempt && record.attempt > 1 ? `, attempt ${record.attempt}` : ""}
            </span>
          </p>
          {record.error && <p className="error-text">{record.error.message}</p>}
          <Expandable label="Input" value={record.input} />
          {"output" in record && <Expandable label="Output" value={record.output} />}
        </>
      );
      break;
    case "approval.requested":
      kind = "asked";
      tone = "waiting";
      body = (
        <p>
          “{record.title}” asked of {approverName(record.approver)}
          {record.requestedBy === "policy" ? (
            <>
              {" "}
              by the policy, holding <code>{record.op}</code>
            </>
          ) : (
            " by the workflow"
          )}
        </p>
      );
      break;
    case "approval.decided":
      kind = record.decision === "approve" ? "approved" : "rejected";
      tone = record.decision === "approve" ? "good" : "bad";
      body = (
        <p>
          {record.by} {record.decision === "approve" ? "approved" : "rejected"} “{title(record.approval)}”
          {record.note ? <q className="note">{record.note}</q> : null}
        </p>
      );
      break;
    case "approval.refused":
      kind = "ignored";
      body = (
        <p>
          Ignored a message from {record.by ?? "someone"} on “{title(record.approval)}”: {record.reason}
        </p>
      );
      break;
    case "run.finished":
      kind = "finished";
      tone = "good";
      body = <Expandable label="Output" value={record.output} />;
      break;
    case "run.failed":
      kind = "failed";
      tone = "bad";
      body = <p className="error-text">{record.error.message}</p>;
      break;
  }
  return (
    <li className={tone ? `tone-${tone}` : undefined}>
      <div className="when">
        <span className="kind">{kind}</span>
        <When at={record.at} />
      </div>
      <div className="what">{body}</div>
    </li>
  );
}
