import type { LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CodeIcon } from "lucide-react";
import { memo, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardHeader, CardTitle } from "#/components/ui/card.tsx";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "#/components/ui/resizable.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import type { ScenarioEntry } from "../api.ts";
import { outlineGraph } from "../graph/outline-graph.ts";
import { runGraph } from "../graph/run-graph.ts";
import { annotateGraph } from "../graph/scenario-graph.ts";
import { type GraphNode, nodeAt } from "../graph/types.ts";
import { sourceQuery, workflowFile } from "../queries.ts";
import type { CodeProps } from "./code.tsx";
import { CodePanel, GraphPanel, Nothing } from "./common.tsx";
import { useDensity } from "./density.tsx";

// A workflow's graph above its source in one card, as a workflow's page and a run's show them. Its
// own module: the resizable panels it uses stay out of the chunks of pages without it.

/**
 * The graph's and the source's shares of the card's height, keyed by panel id, given to the group
 * as `defaultLayout` so the server renders the sizes the browser hydrates (no shift). Never
 * stored: a stored layout would differ from the server's.
 */
const LAYOUT = { "graph-source-graph": 60, "graph-source-code": 40 };

/**
 * A workflow's graph, or a run's (`run`: its ledger and summary, read at `at`), above the
 * workflow's source, in one card: a handle between them shares out its height (sized as `LAYOUT`
 * says at first), the graph fits itself to its new size, and Code hides or shows the source
 * (hidden at first when Compact). A
 * workflow's graph marks what `scenario`, when given, seeds and expects. A click on a node, or in
 * the code, selects the node: the graph rings it and the code marks the lines it may stand for.
 * `onSelect` is told of each node selected, after. Without an outline (it could not be read, or
 * the config has no such workflow) the code's place says why; with no run either there is
 * nothing to draw, and that says why in place of both.
 */
export const GraphAndSource = memo(function GraphAndSource({
  workflow: { name, outline, source },
  run,
  scenario,
  onSelect,
}: {
  /** The workflow's entry, or only its name when the config has no workflow of that name. */
  workflow: Pick<WorkflowEntry, "name"> & Partial<Pick<WorkflowEntry, "outline" | "source">>;
  run?: { ledger: LedgerRecord[]; run: RunSummary; at: number };
  scenario?: Pick<ScenarioEntry, "steps">;
  onSelect?: (node: GraphNode) => void;
}) {
  const steps = outline && "nodes" in outline ? outline.nodes : undefined;
  // The page's one graph: the panel draws it, and a click in the code finds its node in it.
  const graph = useMemo(() => {
    if (run) return runGraph(run.ledger, run.run, run.at, steps);
    const drawn = steps && outlineGraph(steps);
    return drawn && scenario ? annotateGraph(drawn, scenario) : drawn;
  }, [run, steps, scenario]);
  // By id, so a poll's new graph cannot leave an old node selected.
  const [selected, setSelected] = useState<string>();
  const select = useCallback(
    (node: GraphNode | undefined) => {
      setSelected(node?.id);
      if (node) onSelect?.(node);
    },
    [onSelect],
  );
  const selectAt = useCallback((offset: number) => select(graph && nodeAt(graph.nodes, offset)), [graph, select]);
  const highlight = useMemo(() => {
    const span = graph?.nodes.find((node) => node.id === selected)?.span;
    return span && [span];
  }, [graph, selected]);
  const unread =
    outline === undefined
      ? `This config has no workflow named ${name}`
      : "error" in outline
        ? outline.error
        : undefined;
  const noSource = unread !== undefined && <Nothing title="No source to show">{unread}</Nothing>;
  const file = outline && workflowFile({ outline });
  // Open at first, but hidden when Compact: the density's cookie decides on the server and in the
  // browser alike, so both render the same. A later switch of density leaves a card already on
  // the page as it is.
  const { compact } = useDensity();
  const [codeOpen, setCodeOpen] = useState(!compact);
  // The source mounts the first time Code opens (so Compact renders no source, nor loads its view,
  // until asked for it), and is only hidden after: `opened` latches, and the one handler sets it.
  const opened = useRef(codeOpen);
  const toggleCode = () => {
    if (!codeOpen) opened.current = true;
    setCodeOpen(!codeOpen);
  };
  if (!graph) return noSource;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-2 compact:py-1 [.border-b]:pb-2 compact:[.border-b]:pb-1">
        <CardTitle role="heading" aria-level={2} className="text-sm">
          Graph
        </CardTitle>
        <CardAction className="self-center">
          <Button variant="ghost" size="xs" aria-pressed={codeOpen} onClick={toggleCode}>
            <CodeIcon data-icon="inline-start" />
            Code
          </Button>
        </CardAction>
      </CardHeader>
      {/* The group fills its box (its inline `height: 100%` would win over a class); the box carries
          the responsive height, lower when Compact. */}
      <div className="h-[420px] sm:h-[560px] compact:h-[360px]">
        <ResizablePanelGroup id="graph-source" orientation="vertical" defaultLayout={LAYOUT}>
          <ResizablePanel id="graph-source-graph" minSize="25%">
            <GraphPanel graph={graph} show={run ? "end" : "start"} selected={selected} onSelect={select} />
          </ResizablePanel>
          {/* Hidden, not unmounted: the group keeps their sizes, the graph's panel grows to fill it,
              and the code view keeps its scroll. `hidden` on the panel itself (its className styles
              an inner box). */}
          <ResizableHandle withHandle className={codeOpen ? undefined : "hidden"} />
          <ResizablePanel id="graph-source-code" minSize="20%" hidden={!codeOpen}>
            {/* Its own boundary: when Code first opens under Compact, the source's query may have been
                collected while nothing read it, and its refetch then replaces only this panel. */}
            <Suspense
              fallback={<Skeleton role="status" aria-label="Loading the source" className="size-full rounded-none" />}
            >
              {(codeOpen || opened.current) &&
                (noSource ||
                  (file !== undefined ? (
                    <FileSourcePanel file={file} highlight={highlight} onSelect={selectAt} />
                  ) : (
                    <SourcePanel source={source} highlight={highlight} onSelect={selectAt} />
                  )))}
            </Suspense>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Card>
  );
});

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
