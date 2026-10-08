import type { ErrorInfo, LedgerRecord } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { memo, type ReactNode, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { Item, ItemContent, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { approverLabel } from "@sanoma/workflows/shared";
import { starterName } from "../../api.ts";
import { ApprovalCard } from "../../components/approval.tsx";
import {
  DecisionBadge,
  DecisionNote,
  Expandable,
  Fact,
  Facts,
  GraphPanel,
  ledgerTone,
  loadGraph,
  Nothing,
  Notice,
  OpName,
  PageHeader,
  RequestedBy,
  SectionTitle,
  StatusDot,
  toneBadge,
  When,
} from "../../components/common.tsx";
import { useReducedMotion } from "#/lib/motion.ts";
import { utcText } from "#/lib/time.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { runQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/$id")({
  loader: ({ context, params }) => {
    if (!import.meta.env.SSR) void loadGraph();
    return context.queryClient.ensureQueryData(runQuery(params.id));
  },
  head: ({ params }) => ({ meta: [{ title: `Run ${params.id} · Sanoma` }] }),
  component: RunPage,
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});

/** How long a ledger item stays highlighted after a click on its node in the graph. */
const HIGHLIGHT_MS = 2_000;

/** The ledger item a click on the graph lit last, until its timer puts it out. */
let lit: { item: HTMLElement; timer: ReturnType<typeof setTimeout> } | undefined;

/**
 * Scrolls to a record's ledger item and highlights it for a while: an attribute on the element,
 * so the page does not render for it.
 */
function show(recordId: string, reducedMotion: boolean) {
  const item = document.getElementById(ledgerItemId(recordId));
  if (!item) return;
  item.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  if (lit) {
    clearTimeout(lit.timer);
    delete lit.item.dataset.highlighted;
  }
  item.dataset.highlighted = "";
  const timer = setTimeout(() => {
    delete item.dataset.highlighted;
    lit = undefined;
  }, HIGHLIGHT_MS);
  lit = { item, timer };
}

function RunPage() {
  const { id } = Route.useParams();
  const { data, error, dataUpdatedAt } = useSuspenseQuery(runQuery(id));
  const { run, ledger, ledgerError, approvals } = data;
  // A new source on every poll, even one that changed nothing: a sleep's end may have come.
  const source = useMemo(() => ({ ledger, run, at: dataUpdatedAt }), [ledger, run, dataUpdatedAt]);
  const titles = useMemo(() => new Map(approvals.map((a) => [a.id, a.title])), [approvals]);
  const reducedMotion = useReducedMotion();
  const select = (recordId: string) => show(recordId, reducedMotion);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={run.workflow}>
        <Badge className={toneBadge({ tone: RUN_TONE[run.status] })}>{run.status}</Badge>
      </PageHeader>
      {error && <Notice variant="destructive">Could not refresh: {error.message}</Notice>}
      <Card size="sm">
        <CardContent>
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
        </CardContent>
      </Card>

      <section className="flex flex-col gap-3">
        <SectionTitle>Graph</SectionTitle>
        <GraphPanel source={source} onSelect={select} />
      </section>

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
            <ApprovalCard key={approval.id} run={run} approval={approval} />
          ))}
        </aside>
      </div>
    </div>
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

/** One ledger record: what happened, when, and its details. Drawn again only when they change. */
const LedgerRow = memo(function LedgerRow({ record, titles }: { record: LedgerRecord; titles: Map<string, string> }) {
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
    case "sleep.started":
      // A time to come, which a relative time ("just now") would not say: in UTC.
      kind = "sleeping";
      body = (
        <p>
          Until <time dateTime={new Date(record.until).toISOString()}>{utcText(record.until)}</time>
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
    <Item
      role="listitem"
      variant="outline"
      size="sm"
      id={ledgerItemId(record.id)}
      // `show` sets data-highlighted.
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
});
