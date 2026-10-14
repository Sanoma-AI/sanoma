import type { ApprovalState, LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { Span, WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, Suspense, useMemo } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import { starterName } from "../api.ts";
import type { GraphNode, GraphNodeKind } from "../graph/types.ts";
import { spanLines } from "../lib/lines.ts";
import { recordsFor } from "../lib/records.ts";
import { configQuery, opsById, sourceQuery } from "../queries.ts";
import { ApprovalCard } from "./approval.tsx";
import { Fact, Facts, None, OpName, Section, Tip, VendorLogo, When } from "./common.tsx";
import { LedgerRow } from "./ledger.tsx";
import { NewRun } from "./new-run.tsx";
import { WorkflowSections } from "./workflow.tsx";

// The column beside a workflow page's graph: the New run panel, the selected node, or the overview.

/** A node's kind, as the inspector's title names it. Only the kinds a page can select. */
const KIND_TITLE: Partial<Record<GraphNodeKind, string>> = {
  start: "Start",
  end: "End",
  op: "Operation",
  approval: "Approval",
  sleep: "Sleep",
};

/** A run, as the inspector shows it and its nodes' records. */
export interface InspectedRun {
  run: RunSummary;
  ledger: LedgerRecord[];
  approvals: ApprovalState[];
  /** The run's approvals' titles by id, for its ledger rows. */
  titles: Map<string, string>;
}

/**
 * What the inspector shows, first match wins: the New run panel while `?new` is set (a workflow
 * the config has only); the selected `node`, with its lines in the source and, on a run, its
 * ledger records and the approval it waits on, which can be decided here; else the overview,
 * About for the workflow's pane and the run's facts and approvals for a run's. A card the graph's
 * height beside it (the view sizes it), scrolling inside.
 */
export function Inspector({
  workflow,
  run,
  newRun,
  node,
  text,
  onClose,
  onLines,
}: {
  /** The config's entry; none for a retired workflow. */
  workflow: WorkflowEntry | undefined;
  run: InspectedRun | undefined;
  newRun: boolean;
  node: GraphNode | undefined;
  /** The source the nodes' spans index into, for their line numbers: its file's name, or the text itself. */
  text: { file: string } | { source: string | null | undefined };
  /** Unselects the node. */
  onClose: () => void;
  /** Shows the node's lines: opens the Code tab. */
  onLines: () => void;
}) {
  if (newRun && workflow) {
    return (
      <Panel
        title="New run"
        action={
          // Drops `?new` and keeps the rest: the mode chosen stays for the next time.
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="." search={(prev) => ({ ...prev, new: undefined })}>
              <XIcon />
              <span className="sr-only">Close</span>
            </Link>
          </Button>
        }
      >
        <NewRun workflow={workflow} />
      </Panel>
    );
  }
  if (node) {
    return (
      <Panel
        title={KIND_TITLE[node.kind] ?? node.kind}
        // An operation's id is in its facts; a start's label is only its kind.
        description={node.kind === "op" || node.label === node.kind ? undefined : node.label}
        action={
          <Tip tip="Show the overview">
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </Tip>
        }
      >
        <NodeFacts node={node} text={text} onLines={onLines} />
        {run && <NodeRecords node={node} run={run} />}
      </Panel>
    );
  }
  if (run) {
    const { run: summary, approvals } = run;
    return (
      <Panel title="Run">
        <Facts>
          <Fact label="Started by">{starterName(summary)}</Fact>
          <Fact label="Started">
            <When at={summary.createdAt} />
          </Fact>
          <Fact label="Run id">
            <code className="break-all">{summary.runId}</code>
          </Fact>
        </Facts>
        <Section title="Approvals">
          {approvals.length === 0 && <None>None asked for.</None>}
          {approvals.map((approval) => (
            <ApprovalCard key={approval.id} run={summary} approval={approval} />
          ))}
        </Section>
      </Panel>
    );
  }
  if (!workflow) return null;
  return (
    <Panel title="About">
      <WorkflowSections workflow={workflow} />
    </Panel>
  );
}

/** The inspector's card: its title, a description under it, an action at its end, and what it holds, scrolling. */
function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card aria-label="Inspector" role="region" className="h-full gap-0 py-0">
      <CardHeader className="border-b py-2 compact:py-1 [.border-b]:pb-2 compact:[.border-b]:pb-1">
        <CardTitle role="heading" aria-level={2} className="self-center text-sm">
          {title}
        </CardTitle>
        {description && <CardDescription className="wrap-anywhere">{description}</CardDescription>}
        {action && <CardAction className="self-center">{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-(--card-spacing) overflow-y-auto py-(--card-spacing)">
        {children}
      </CardContent>
    </Card>
  );
}

/** What the node is: its operation (vendor, effect and what it does), and where it is in the source. */
function NodeFacts({
  node,
  text,
  onLines,
}: {
  node: GraphNode;
  text: { file: string } | { source: string | null | undefined };
  onLines: () => void;
}) {
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const { data: vendors } = useSuspenseQuery({ ...configQuery(), select: (config) => config.vendors });
  const op = node.kind === "op" ? ops.get(node.label) : undefined;
  if (node.kind !== "op" && !node.span) return null;
  return (
    <Facts>
      {node.kind === "op" && (
        <>
          <Fact label="Calls">
            <span className="flex flex-wrap items-center gap-2">
              <OpName id={node.label} op={op} />
            </span>
          </Fact>
          {op && (
            <Fact label="Vendor">
              <span className="flex items-center gap-2">
                <VendorLogo vendor={op.vendor} alt="" />
                {vendors[op.vendor]?.title ?? op.vendor}
              </span>
            </Fact>
          )}
          {op?.description && <Fact label="Does">{op.description}</Fact>}
          {node.ops && node.ops.length > 0 && (
            <Fact label="Can reach">
              <span className="flex flex-col">
                {node.ops.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </span>
            </Fact>
          )}
        </>
      )}
      {node.span && (
        <Fact label="Source">
          {/* Its own boundary: the source's query may have been collected while nothing read it. */}
          <Suspense fallback="…">
            <Lines span={node.span} text={text} onClick={onLines} />
          </Suspense>
        </Fact>
      )}
    </Facts>
  );
}

/** "Lines a–b" of the node's span, which opens the Code tab, where they are marked. */
function Lines({
  span,
  text,
  onClick,
}: {
  span: Span;
  text: { file: string } | { source: string | null | undefined };
  onClick: () => void;
}) {
  if ("file" in text) return <FileLines file={text.file} span={span} onClick={onClick} />;
  return text.source == null ? null : <LinesButton lines={spanLines(text.source, span)} onClick={onClick} />;
}

function FileLines({ file, span, onClick }: { file: string; span: Span; onClick: () => void }) {
  const { data } = useSuspenseQuery(sourceQuery(file));
  return data.source == null ? null : <LinesButton lines={spanLines(data.source, span)} onClick={onClick} />;
}

function LinesButton({ lines: [first, last], onClick }: { lines: [number, number]; onClick: () => void }) {
  return (
    <Button variant="link" size="xs" className="h-auto p-0" onClick={onClick}>
      {first === last ? `Line ${first}` : `Lines ${first}–${last}`}
    </Button>
  );
}

/**
 * A run node's ledger records, and the approval it waits on (an approval's own, or the policy's
 * on a held call), decided here.
 */
function NodeRecords({ node, run }: { node: GraphNode; run: InspectedRun }) {
  const records = useMemo(() => recordsFor(node, run.ledger), [node, run.ledger]);
  const approval = "state" in node && node.state && "approval" in node.state ? node.state.approval : undefined;
  return (
    <>
      {approval?.status === "pending" && <ApprovalCard run={run.run} approval={approval} />}
      {records.length > 0 && (
        <Section title="Ledger">
          <ItemGroup aria-label="Its ledger records">
            {records.map((record) => (
              <LedgerRow key={record.id} record={record} titles={run.titles} anchor={false} />
            ))}
          </ItemGroup>
        </Section>
      )}
    </>
  );
}
