import type { ApprovalState, LedgerRecord } from "@sanoma/workflows";
import type { ReactNode } from "react";
import type { RunDetail } from "../../src/api.ts";
import { ApprovalCard, DecisionBadge, EffectBadge, Expandable, Notice, RunStatus, When } from "../components.tsx";
import { usePoll } from "../lib.ts";

export function RunPage({ id }: { id: string }) {
  const { data, error, missing, reload } = usePoll<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);

  if (missing) return <Notice tone="bad">No run {id}.</Notice>;
  if (!data) return error ? <Notice tone="bad">Could not load the run: {error}</Notice> : <Notice>Loading…</Notice>;

  const { run, ledger, ledgerError, approvals } = data;
  const titles = new Map(approvals.map((a) => [a.id, a.title]));
  return (
    <section>
      <header className="page-head">
        <h1>
          {run.workflow} <RunStatus status={run.status} />
        </h1>
      </header>
      {error && <Notice tone="bad">Could not refresh: {error}</Notice>}
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
          {approvals.map((approval: ApprovalState) => (
            <ApprovalCard key={approval.id} runId={run.runId} approval={approval} onDecided={reload} />
          ))}
        </aside>
      </div>
    </section>
  );
}

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
          “{record.title}” asked of {record.approver}
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
