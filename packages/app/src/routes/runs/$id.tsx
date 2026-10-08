import type { ErrorInfo, LedgerRecord } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Item, ItemContent, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { approverLabel } from "@sanoma/workflows/shared";
import { starterName } from "../../api.ts";
import { ApprovalCard } from "../../components/approval.tsx";
import {
  DecisionBadge,
  DecisionNote,
  effectBadge,
  Expandable,
  Fact,
  Facts,
  ledgerTone,
  Nothing,
  Notice,
  PageHeader,
  RequestedBy,
  RUN_TONE,
  SectionTitle,
  StatusDot,
  toneBadge,
  When,
} from "../../components/common.tsx";
import { configQuery, runQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/$id")({
  // The config too: each approval badges the operations it covers by their effect.
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(runQuery(params.id)),
      context.queryClient.ensureQueryData(configQuery()),
    ]),
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Sanoma` }] }),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});

function RunPage() {
  const { id } = Route.useParams();
  const { data, error } = useSuspenseQuery(runQuery(id));
  const { run, ledger, ledgerError, approvals } = data;
  const titles = new Map(approvals.map((a) => [a.id, a.title]));
  return (
    <section className="flex flex-col gap-6">
      <PageHeader title={run.workflow}>
        <Badge className={toneBadge({ tone: RUN_TONE[run.status] })}>{run.status}</Badge>
      </PageHeader>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
      <Facts>
        <Fact label="Started by">{starterName(run)}</Fact>
        <Fact label="Started">
          <When at={run.createdAt} />
        </Fact>
        <Fact label="Run id">
          <code className="break-all">{run.runId}</code>
        </Fact>
        {run.error && (
          <Fact label="Error">
            <span className="text-destructive">{run.error}</span>
          </Fact>
        )}
      </Facts>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          <SectionTitle>Ledger</SectionTitle>
          {ledgerError && <Notice variant="destructive">Could not read the ledger: {ledgerError}</Notice>}
          {ledger.length === 0 && !ledgerError && <Nothing title="Nothing recorded yet" />}
          {ledger.length > 0 && (
            <ItemGroup aria-label="Ledger">
              {ledger.map((record) => (
                <LedgerRow key={record.id} record={record} titles={titles} />
              ))}
            </ItemGroup>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <SectionTitle>Approvals</SectionTitle>
          {approvals.length === 0 && <Nothing title="None asked for" />}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} runId={run.runId} runStatus={run.status} approval={approval} />
          ))}
        </aside>
      </div>
    </section>
  );
}

/** An error from the ledger, with what the vendor said when the driver kept it. */
function ErrorText({ error }: { error: ErrorInfo }) {
  const vendor = [error.status === undefined ? "" : `status ${error.status}`, error.vendorCode ?? ""]
    .filter(Boolean)
    .join(", ");
  return (
    <p className="text-destructive">
      {error.message}
      {vendor && <span className="text-muted-foreground"> ({vendor})</span>}
    </p>
  );
}

/** One ledger record: what happened, when, and its details. */
function LedgerRow({ record, titles }: { record: LedgerRecord; titles: Map<string, string> }) {
  const title = (approval: string) => titles.get(approval) ?? approval;
  let kind = "";
  let body: ReactNode;
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
      body = (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <code>{record.op}</code> <Badge className={effectBadge({ effect: record.effect })}>{record.effect}</Badge>{" "}
            <DecisionBadge decision={record.decision} />
            <span className="text-muted-foreground">
              {record.durationMs} ms{record.attempt && record.attempt > 1 ? `, attempt ${record.attempt}` : ""}
            </span>
          </p>
          {record.error && <ErrorText error={record.error} />}
          <Expandable label="Input" value={record.input} />
          {"output" in record && <Expandable label="Output" value={record.output} />}
        </>
      );
      break;
    case "approval.requested":
      kind = "asked";
      body = (
        <p>
          “{record.title}” asked of {approverLabel(record.approver)} by{" "}
          <RequestedBy requestedBy={record.requestedBy} op={record.op} />
        </p>
      );
      break;
    case "approval.decided":
      kind = record.decision === "approve" ? "approved" : "rejected";
      body = (
        <p>
          {record.by} {record.decision === "approve" ? "approved" : "rejected"} “{title(record.approval)}”
          {record.note ? <DecisionNote note={record.note} /> : null}
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
      body = <Expandable label="Output" value={record.output} />;
      break;
    case "run.failed":
      kind = "failed";
      body = <ErrorText error={record.error} />;
      break;
  }
  return (
    <Item role="listitem" variant="outline" size="sm">
      <ItemContent className="min-w-0">
        <ItemTitle>
          <StatusDot tone={ledgerTone(record)} />
          {kind}
          <span className="font-normal text-muted-foreground">
            <When at={record.at} />
          </span>
        </ItemTitle>
        <div className="flex flex-col gap-1">{body}</div>
      </ItemContent>
    </Item>
  );
}
