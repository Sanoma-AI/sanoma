import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { approverLabel } from "@sanoma/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { type ReactNode, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import { pendingApprovals, type RunDetail, type ScenarioEntry } from "../api.ts";
import { outlineGraph } from "../graph/outline-graph.ts";
import { runGraph } from "../graph/run-graph.ts";
import { annotateGraph } from "../graph/scenario-graph.ts";
import { type GraphNode, nodeAt } from "../graph/types.ts";
import { useReducedMotion } from "../lib/motion.ts";
import { nodesByRecord } from "../lib/records.ts";
import { sourceQuery, workflowFile } from "../queries.ts";
import type { CodeProps } from "./code.tsx";
import { CodePanel, GraphPanel, Nothing, Notice, Region } from "./common.tsx";
import { type InspectedRun, Inspector } from "./inspector.tsx";
import { CheckRow, LedgerRow, show } from "./ledger.tsx";

// One view for a workflow and its runs: the graph beside an inspector, then Code and Ledger tabs.

type Tab = "code" | "ledger";

/**
 * A workflow's graph, or a run's (`run`, read at `at`), as either pane of the workflow's page
 * shows it, inside the pane's container (`@container/pane`):
 * - `children` (the pane's notices), then for a run waiting on someone a banner naming who and
 *   for what, which selects the approval's node, or a failed run's error;
 * - the graph card beside the inspector, 22rem wide, or above it while the pane is narrower than
 *   `@3xl` (by the pane's own width: beside the sidebar and the rail a pane is about 480 px wide on
 *   a 1024 px screen). The graph card sets the row's height; the inspector scrolls inside it;
 * - Code and, for a run, Ledger tabs under them.
 *
 * A click on a node, in the code, or a ledger row's "Show in graph" selects the node: the graph
 * rings it, the code marks its lines, the inspector shows it, and while the Ledger tab is open
 * the ledger scrolls to its record. A workflow's graph marks what `scenario`, when given, seeds
 * and expects. Without an outline (it could not be read, or the config has no such workflow) the
 * code tab says why; with no run either, there is nothing to draw, and that says why instead.
 */
export function WorkflowView({
  name,
  workflow,
  run,
  scenario,
  children,
}: {
  name: string;
  /** The config's entry; none for a retired workflow, whose runs still draw a graph. */
  workflow: WorkflowEntry | undefined;
  run?: (RunDetail & { at: number }) | undefined;
  scenario?: Pick<ScenarioEntry, "steps"> | undefined;
  children?: ReactNode;
}) {
  const outline = workflow?.outline;
  const steps = outline && "nodes" in outline ? outline.nodes : undefined;
  const ledger = run?.ledger;
  const summary = run?.run;
  const at = run?.at ?? 0;
  // The page's one graph: the panel draws it, a click in the code finds its node in it, and a
  // ledger row its node. A poll that changed nothing keeps the ledger and summary, so the graph.
  const graph = useMemo(() => {
    if (ledger && summary) return runGraph(ledger, summary, at, steps);
    const drawn = steps && outlineGraph(steps);
    return drawn && scenario ? annotateGraph(drawn, scenario) : drawn;
  }, [ledger, summary, at, steps, scenario]);
  const nodeOf = useMemo(() => (graph && ledger ? nodesByRecord(graph.nodes, ledger) : undefined), [graph, ledger]);
  const titles = useMemo(() => new Map(run?.approvals.map((a) => [a.id, a.title])), [run?.approvals]);
  const inspected = useMemo<InspectedRun | undefined>(
    () => run && { run: run.run, ledger: run.ledger, approvals: run.approvals, titles },
    [run, titles],
  );
  const newRun = useSearch({ from: "/workflows/$name", select: (search) => search.new === true });

  const [tab, setTab] = useState<Tab>(run ? "ledger" : "code");
  // By id, so a poll's new graph cannot leave an old node selected.
  const [selected, setSelected] = useState<string>();
  const node = graph?.nodes.find((n) => n.id === selected);
  const reducedMotion = useReducedMotion();
  const select = useCallback(
    (picked: GraphNode | undefined) => {
      setSelected(picked?.id);
      const recordId = picked && "state" in picked ? picked.state?.recordId : undefined;
      if (recordId && tab === "ledger") show(recordId, reducedMotion);
    },
    [tab, reducedMotion],
  );
  const selectAt = useCallback((offset: number) => select(graph && nodeAt(graph.nodes, offset)), [graph, select]);
  // From the ledger: the graph comes into view with its node ringed, and the ledger stays put.
  const graphCard = useRef<HTMLDivElement>(null);
  const showInGraph = useCallback(
    (recordId: string) => {
      setSelected(nodeOf?.get(recordId));
      graphCard.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
    },
    [nodeOf, reducedMotion],
  );
  const highlight = useMemo(() => node?.span && [node.span], [node]);

  const unread =
    outline === undefined
      ? `This config has no workflow named ${name}`
      : "error" in outline
        ? outline.error
        : undefined;
  const noSource = unread !== undefined && <Nothing title="No source to show">{unread}</Nothing>;
  if (!graph) return noSource;
  const file = outline && workflowFile({ outline });
  const text = file !== undefined ? { file } : { source: workflow?.source };
  const waiting = summary?.status === "waiting" ? pendingApprovals(summary)[0] : undefined;
  const waitingNode =
    waiting &&
    graph.nodes.find((n) => "state" in n && n.state && "approval" in n.state && n.state.approval?.id === waiting.id);

  return (
    <div className="@container/pane flex flex-col gap-(--gap-region)">
      {children}
      {waiting && (
        <Notice>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            Waiting on {approverLabel(waiting.approver)} for “{waiting.title}”
            {waitingNode && (
              <Button variant="outline" size="xs" onClick={() => select(waitingNode)}>
                Show approval
              </Button>
            )}
          </span>
        </Notice>
      )}
      {summary?.error && <Notice variant="destructive">{summary.error}</Notice>}
      <div className="grid gap-(--gap-region) @3xl/pane:grid-cols-[minmax(0,1fr)_22rem]">
        <Card ref={graphCard} className="scroll-mt-4 gap-0 overflow-hidden py-0">
          <CardHeader className="border-b py-2 compact:py-1 [.border-b]:pb-2 compact:[.border-b]:pb-1">
            <CardTitle role="heading" aria-level={2} className="text-sm">
              Graph
            </CardTitle>
          </CardHeader>
          {/* The row's height: lower on a phone, and when Compact. */}
          <div className="h-[420px] sm:h-[560px] compact:h-[440px]">
            <GraphPanel graph={graph} show={run ? "end" : "start"} selected={selected} onSelect={select} />
          </div>
        </Card>
        {/* Beside the graph, the inspector takes the graph's height and scrolls inside it; above it,
            its own. */}
        <div className="min-w-0 @3xl/pane:relative">
          <div className="@3xl/pane:absolute @3xl/pane:inset-0">
            <Inspector
              workflow={workflow}
              run={inspected}
              newRun={newRun}
              node={node}
              text={text}
              onClose={() => setSelected(undefined)}
              onLines={() => setTab("code")}
            />
          </div>
        </div>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-(--gap-section)">
        <TabsList>
          <TabsTrigger value="code">Code</TabsTrigger>
          {run && <TabsTrigger value="ledger">Ledger</TabsTrigger>}
        </TabsList>
        <TabsContent value="code">
          <Card className="h-[420px] gap-0 overflow-hidden py-0 sm:h-[480px] compact:h-[360px]">
            {/* Its own boundary: the source's query may have been collected while nothing read
                it, and its refetch then replaces only this card's content. */}
            <Suspense
              fallback={<Skeleton role="status" aria-label="Loading the source" className="size-full rounded-none" />}
            >
              {noSource ||
                (file !== undefined ? (
                  <FileSourcePanel file={file} highlight={highlight} onSelect={selectAt} />
                ) : (
                  <SourcePanel source={workflow?.source} highlight={highlight} onSelect={selectAt} />
                ))}
            </Suspense>
          </Card>
        </TabsContent>
        {run && (
          <TabsContent value="ledger" className="flex flex-col gap-(--gap-region)">
            <RunLedger run={run} titles={titles} nodeOf={nodeOf} onShow={showInGraph} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

/** A run's checks (a sandbox run's), then its ledger, each row with "Show in graph" when a node stands for it. */
function RunLedger({
  run: { ledger, ledgerError, checks, checksError },
  titles,
  nodeOf,
  onShow,
}: {
  run: RunDetail;
  titles: Map<string, string>;
  /** The nodes the records are drawn as, by record id (`nodesByRecord`). */
  nodeOf: Map<string, string> | undefined;
  onShow: (recordId: string) => void;
}) {
  return (
    <>
      {(checks || checksError) && (
        <Region title="Checks">
          {checksError && (
            <Notice variant="destructive">
              {/* A step no rule matches lists the known steps, one a line. */}
              <span className="whitespace-pre-wrap">Could not check the run against its scenario: {checksError}</span>
            </Notice>
          )}
          {checks && (
            <ItemGroup aria-label="Checks">
              {checks.map((c, i) => (
                <CheckRow key={i} check={c} />
              ))}
            </ItemGroup>
          )}
        </Region>
      )}
      {ledgerError && <Notice variant="destructive">Could not read the ledger: {ledgerError}</Notice>}
      {ledger.length === 0 && !ledgerError && <Nothing title="Nothing recorded yet" />}
      {ledger.length > 0 && (
        <ItemGroup aria-label="Ledger">
          {ledger.map((record) => (
            <LedgerRow
              key={record.id}
              record={record}
              titles={titles}
              onShow={nodeOf?.has(record.id) ? onShow : undefined}
            />
          ))}
        </ItemGroup>
      )}
    </>
  );
}

type SourceProps = Pick<CodeProps, "highlight" | "onSelect">;

/** A workflow's file, as it is now. */
function FileSourcePanel({ file, ...props }: { file: string } & SourceProps) {
  const { data } = useSuspenseQuery(sourceQuery(file));
  return <SourcePanel source={data.source} {...props} />;
}

/** The text the outline's spans index into, or why there is none. */
function SourcePanel({ source, ...props }: { source: string | null | undefined } & SourceProps) {
  return source == null ? <Nothing title="No source to show" /> : <CodePanel source={source} {...props} />;
}
