import type { ErrorInfo } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Item, ItemContent, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { approverLabel } from "@sanoma/workflows/shared";
import { type GraphRecord, starterName } from "../../api.ts";
import { ApprovalCard } from "../../components/approval.tsx";
import {
  DecisionBadge,
  DecisionNote,
  Expandable,
  Fact,
  Facts,
  ledgerTone,
  Nothing,
  Notice,
  OpName,
  PageHeader,
  RequestedBy,
  RUN_TONE,
  SectionTitle,
  StatusDot,
  toneBadge,
  When,
} from "../../components/common.tsx";
import { runQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/$id")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(runQuery(params.id)),
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Sanoma` }] }),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});

// React Flow needs the DOM: the graph loads in the browser only, as its own chunk.
const RunGraph = lazy(() => import("../../components/run-graph.tsx"));

/** How long a ledger item stays highlighted after a click on its node in the graph. */
const HIGHLIGHT_MS = 2_000;

function RunPage() {
  const { id } = Route.useParams();
  const { data, error } = useSuspenseQuery(runQuery(id));
  const { run, ledger, ledgerError, approvals } = data;
  // The runtime's records, with the fields it adds that LedgerRecord does not declare yet.
  const records: GraphRecord[] = ledger;
  const titles = new Map(approvals.map((a) => [a.id, a.title]));
  const [highlighted, setHighlighted] = useState<string>();
  useEffect(() => {
    if (highlighted === undefined) return;
    const timer = setTimeout(() => setHighlighted(undefined), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);
  const show = useCallback((recordId: string) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(ledgerItemId(recordId))
      ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    setHighlighted(recordId);
  }, []);
  const skeleton = <Skeleton role="status" aria-label="Loading the graph" className="size-full rounded-none" />;
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

      <section className="flex flex-col gap-3">
        <SectionTitle>Graph</SectionTitle>
        <div className="h-[220px] overflow-hidden rounded-lg border sm:h-[280px]">
          <ClientOnly fallback={skeleton}>
            <Suspense fallback={skeleton}>
              <RunGraph records={records} run={run} onSelect={show} />
            </Suspense>
          </ClientOnly>
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-3">
          <SectionTitle>Ledger</SectionTitle>
          {ledgerError && <Notice variant="destructive">Could not read the ledger: {ledgerError}</Notice>}
          {records.length === 0 && !ledgerError && <Nothing title="Nothing recorded yet" />}
          {records.length > 0 && (
            <ItemGroup aria-label="Ledger">
              {records.map((record) => (
                <LedgerRow key={record.id} record={record} titles={titles} highlighted={record.id === highlighted} />
              ))}
            </ItemGroup>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <SectionTitle>Approvals</SectionTitle>
          {approvals.length === 0 && <Nothing title="None asked for" />}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} run={run} approval={approval} />
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

/** A ledger record's item on the page, by the record's id: where a click on the graph leads. */
const ledgerItemId = (recordId: string) => `ledger-${recordId}`;

/** One ledger record: what happened, when, and its details. */
function LedgerRow({
  record,
  titles,
  highlighted,
}: {
  record: GraphRecord;
  titles: Map<string, string>;
  highlighted: boolean;
}) {
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
            <OpName id={record.op} effect={record.effect} />
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
    case "sleep.started": {
      // A time to come, which a relative time ("just now") would not say: the server's UTC.
      const until = new Date(record.until).toISOString();
      kind = "sleeping";
      body = (
        <p>
          Until <time dateTime={until}>{until.replace("T", " ").slice(0, 16)} UTC</time>
        </p>
      );
      break;
    }
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
    <Item
      role="listitem"
      variant="outline"
      size="sm"
      id={ledgerItemId(record.id)}
      data-highlighted={highlighted || undefined}
      className="scroll-mt-24 data-highlighted:bg-muted data-highlighted:ring-2 data-highlighted:ring-ring"
    >
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
