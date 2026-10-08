import type { LedgerRecord } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from "@/components/ui/item";
import { approverName } from "../../api.ts";
import { ApprovalCard } from "../../components/approval.tsx";
import {
  DecisionBadge,
  effectBadge,
  Expandable,
  Fact,
  Facts,
  ledgerTone,
  Nothing,
  Notice,
  PageHeader,
  RUN_TONE,
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
  notFoundComponent: () => <Notice tone="bad">No run {Route.useParams().id}.</Notice>,
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
      {error && <Notice tone="bad">Could not refresh: {error.message}</Notice>}
      <Facts>
        <Fact label="Started by">{run.startedBy?.id ?? "unknown"}</Fact>
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
          <h2>Ledger</h2>
          {ledger === null && <Notice>This config has no ledger store, so there is no record to show.</Notice>}
          {ledgerError && <Notice tone="bad">Could not read the ledger: {ledgerError}</Notice>}
          {ledger && ledger.length === 0 && !ledgerError && <Nothing title="Nothing recorded yet" />}
          {ledger && ledger.length > 0 && (
            <Card size="sm">
              <CardContent>
                <ItemGroup className="gap-0" aria-label="Ledger">
                  {ledger.map((record, i) => (
                    <Fragment key={record.id}>
                      {i > 0 && <ItemSeparator className="my-0" />}
                      <LedgerRow record={record} titles={titles} />
                    </Fragment>
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
          )}
        </div>
        <aside className="flex flex-col gap-3">
          <h2>Approvals</h2>
          {approvals.length === 0 && <Nothing title="None asked for" />}
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
          {record.error && <p className="text-destructive">{record.error.message}</p>}
          <Expandable label="Input" value={record.input} />
          {"output" in record && <Expandable label="Output" value={record.output} />}
        </>
      );
      break;
    case "approval.requested":
      kind = "asked";
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
      body = (
        <p>
          {record.by} {record.decision === "approve" ? "approved" : "rejected"} “{title(record.approval)}”
          {record.note ? <q className="block text-muted-foreground italic">{record.note}</q> : null}
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
      body = <p className="text-destructive">{record.error.message}</p>;
      break;
  }
  return (
    <Item role="listitem" size="sm" className="items-start px-0">
      <ItemMedia className="pt-1.5">
        <StatusDot tone={ledgerTone(record)} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
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
