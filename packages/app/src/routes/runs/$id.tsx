import type { ErrorInfo, LedgerRecord } from "@sanoma/workflows";
import type { ConfigDescription, OpEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { memo, type ReactNode, useMemo } from "react";
import { Card, CardContent } from "#/components/ui/card.tsx";
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
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
  pageTitle,
  plural,
  RequestedBy,
  SectionTitle,
  StatusDot,
  ToneBadge,
  When,
} from "../../components/common.tsx";
import { useReducedMotion } from "#/lib/motion.ts";
import { utcText } from "#/lib/time.ts";
import { RUN_TONE } from "#/lib/tone.ts";
import { configQuery, opsById, runQuery } from "../../queries.ts";

export const Route = createFileRoute("/runs/$id")({
  // The page reads the run from the query client; the loader returns only its name: its workflow.
  loader: async ({ context, params }) => {
    if (!import.meta.env.SSR) void loadGraph();
    const { run } = await context.queryClient.query({ ...runQuery(params.id), staleTime: "static" });
    return { crumb: run.workflow };
  },
  // A run that does not exist has no loader data: its id stands in.
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.id),
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
      <PageHeader>
        <ToneBadge tone={RUN_TONE[run.status]}>{run.status}</ToneBadge>
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

      <div className="flex flex-col gap-3">
        <SectionTitle>Graph</SectionTitle>
        <GraphPanel source={source} onSelect={select} />
      </div>

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
        <div className="flex flex-col gap-3">
          <SectionTitle>Approvals</SectionTitle>
          {approvals.length === 0 && <Nothing title="None asked for" />}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} run={run} approval={approval} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** An error from the ledger, with what the vendor said when the driver kept it, and `then`: what came of it. */
function ErrorText({ error, then }: { error: ErrorInfo; then?: string | undefined }) {
  const vendor = [error.status === undefined ? "" : `status ${error.status}`, error.vendorCode ?? ""]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <p className="text-destructive">
        {error.message}
        {vendor && <span className="text-muted-foreground"> ({vendor})</span>}
      </p>
      {then && <p className="text-muted-foreground">{then}</p>}
    </>
  );
}

/** Whether a failed call was tried again, from its attempt and the config's entry for its operation. */
function retries(attempt: number, op: OpEntry | undefined, vendors: ConfigDescription["vendors"]) {
  if (attempt > 1 || op?.idempotent) return `Tried ${plural(attempt, "time")}`;
  if (!op) return undefined;
  const vendor = vendors[op.vendor]?.title ?? op.vendor;
  return `Not retried: this operation is not safe to repeat. Check ${vendor} before starting again.`;
}

/** A ledger record's item on the page, by the record's id: where a click on the graph leads. */
const ledgerItemId = (recordId: string) => `ledger-${recordId}`;

/** One ledger record: what happened, when, and its details. Drawn again only when they change. */
const LedgerRow = memo(function LedgerRow({ record, titles }: { record: LedgerRecord; titles: Map<string, string> }) {
  const title = (approval: string) => titles.get(approval) ?? approval;
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select: (config) => config.vendors });
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
            <OpName id={record.op} op={ops.get(record.op)} effect={record.effect} />
            <DecisionBadge decision={record.decision} />
            <span className="text-muted-foreground">
              {record.durationMs} ms{record.attempt && record.attempt > 1 ? `, attempt ${record.attempt}` : ""}
            </span>
          </p>
          {record.error && (
            <ErrorText error={record.error} then={retries(record.attempt ?? 1, ops.get(record.op), vendors)} />
          )}
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
        </ItemTitle>
        <div className="flex flex-col gap-1">{body}</div>
      </ItemContent>
      <ItemActions className="self-start text-xs text-muted-foreground">
        <When at={record.at} />
      </ItemActions>
    </Item>
  );
});
