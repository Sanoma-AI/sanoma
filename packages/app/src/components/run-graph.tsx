// React Flow's stylesheet, once, in this chunk: only the run page loads it. style.css maps its
// --xy-* colours to the theme.
// oxlint-disable-next-line import/no-unassigned-import
import "@xyflow/react/dist/style.css";
import type { RunSummary } from "@sanoma/workflows";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  type NodeTypes,
  PanOnScrollMode,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { cva } from "class-variance-authority";
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import type { GraphRecord } from "../api.ts";
import { layout, NODE_SIZE } from "../graph/layout.ts";
import { type GraphNode, type GraphNodeKind, runGraph } from "../graph/run-graph.ts";
import { configQuery, opsById } from "../queries.ts";
import { APPROVAL_TONE, DECISION_TONE, effectBadge, StatusDot, type Tone, toneBadge } from "./common.tsx";

// The run graph, drawn with React Flow. It needs the DOM, so the run page loads this module
// only in the browser (React.lazy behind ClientOnly); the server renders a skeleton instead.

type FlowNode = Node<{ node: GraphNode }, GraphNodeKind>;

/** How the view fits the graph (the controls' fit button fits all of it). */
const FIT = { padding: 0.1, minZoom: 0.25, maxZoom: 1 } as const;
/** Below this zoom the badges cannot be read: fit the run's latest part instead of all of it. */
const READABLE_ZOOM = 0.8;

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function watchReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const useReducedMotion = () =>
  useSyncExternalStore(
    watchReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  );

const frame = cva(
  "flex size-full cursor-pointer flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 text-xs text-card-foreground shadow-xs transition-colors hover:bg-muted",
  {
    variants: {
      tone: {
        ok: "border-tone-ok-foreground/40",
        bad: "border-tone-bad-foreground/70",
        waiting: "border-tone-waiting-foreground/70",
        active: "border-tone-active-foreground/70",
        idle: "border-tone-idle-foreground/50",
        off: "border-border",
      } satisfies Record<Tone, string>,
      pending: { true: "border-dashed bg-transparent" },
    },
  },
);

/** One node's box, with handles where edges meet it (hidden: nothing connects by hand here). */
function Frame({
  node,
  inbound = true,
  outbound = true,
  children,
}: {
  node: GraphNode;
  inbound?: boolean;
  outbound?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={frame({ tone: node.tone, pending: node.kind === "end" && node.state === "pending" })}
      title={node.label}
    >
      {inbound && <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />}
      {children}
      {outbound && <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />}
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-1.5">{children}</div>;
}

function StartNode({ data: { node } }: NodeProps<FlowNode>) {
  return (
    <Frame node={node} inbound={false}>
      <Line>
        <StatusDot tone={node.tone} />
        start
      </Line>
    </Frame>
  );
}

function EndNode({ data: { node } }: NodeProps<FlowNode>) {
  if (node.kind !== "end") return null;
  return (
    <Frame node={node} outbound={false}>
      <Line>
        <StatusDot tone={node.tone} />
        <span className={node.state === "pending" ? "text-muted-foreground" : ""}>{node.label}</span>
      </Line>
    </Frame>
  );
}

function OpNode({ data: { node } }: NodeProps<FlowNode>) {
  // A call still held for its approval has no record yet, so no effect: the config knows it.
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  if (node.kind !== "op") return null;
  const effect = node.effect ?? ops.get(node.op)?.effect;
  return (
    <Frame node={node}>
      <Line>
        <StatusDot tone={node.tone} />
        <code className="truncate">{node.op}</code>
      </Line>
      <Line>
        {effect && <Badge className={effectBadge({ effect })}>{effect}</Badge>}
        {node.hold && node.decision === undefined ? (
          <Badge className={toneBadge({ tone: APPROVAL_TONE[node.hold.state] })} title={node.hold.title}>
            {node.hold.state === "pending" ? `held · ${node.hold.approver}` : node.hold.state}
          </Badge>
        ) : (
          node.decision && <Badge className={toneBadge({ tone: DECISION_TONE[node.decision] })}>{node.decision}</Badge>
        )}
        {node.errorCode ? (
          <span className="truncate text-destructive">{node.errorCode}</span>
        ) : (
          node.durationMs !== undefined && <span className="text-muted-foreground">{node.durationMs} ms</span>
        )}
      </Line>
    </Frame>
  );
}

function ApprovalNode({ data: { node } }: NodeProps<FlowNode>) {
  if (node.kind !== "approval") return null;
  return (
    <Frame node={node}>
      <Line>
        <StatusDot tone={node.tone} />
        <span className="truncate">“{node.title}”</span>
      </Line>
      <Line>
        <Badge className={toneBadge({ tone: APPROVAL_TONE[node.state] })}>{node.state}</Badge>
        <span className="truncate text-muted-foreground">{node.approver}</span>
      </Line>
    </Frame>
  );
}

function SleepNode({ data: { node } }: NodeProps<FlowNode>) {
  if (node.kind !== "sleep") return null;
  return (
    <Frame node={node}>
      <Line>
        <StatusDot tone={node.tone} />
        <span className="truncate">sleep until {new Date(node.until).toLocaleString()}</span>
      </Line>
    </Frame>
  );
}

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  op: OpNode,
  approval: ApprovalNode,
  sleep: SleepNode,
} satisfies Record<GraphNodeKind, unknown>;

/** Fits the view again when nodes come or go, as the run's page polls. */
function FitOnChange({ nodes, onFitted }: { nodes: FlowNode[]; onFitted: () => void }) {
  const { fitView, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const count = nodes.length;
  useEffect(() => {
    if (!width || !height || !count) return;
    const left = Math.min(...nodes.map((n) => n.position.x));
    const right = Math.max(...nodes.map((n) => n.position.x + (n.width ?? 0)));
    const top = Math.min(...nodes.map((n) => n.position.y));
    const bottom = Math.max(...nodes.map((n) => n.position.y + (n.height ?? 0)));
    // All of the graph when it fits at a readable zoom. Else its right-hand end, the run's
    // latest steps, at that zoom; panning shows the rest.
    const fits = (right - left) * READABLE_ZOOM <= width * (1 - 2 * FIT.padding);
    const done = fits
      ? fitView(FIT)
      : setViewport({
          zoom: READABLE_ZOOM,
          x: width * (1 - FIT.padding) - right * READABLE_ZOOM,
          y: height / 2 - ((top + bottom) / 2) * READABLE_ZOOM,
        });
    void done.then(onFitted);
    // Only when nodes come or go, or the view resizes: not on every poll.
  }, [count, width, height, fitView, setViewport]);
  return null;
}

export interface RunGraphProps {
  records: readonly GraphRecord[];
  run: RunSummary;
  /** Called with a clicked node's ledger record id. */
  onSelect: (recordId: string) => void;
}

/** The run as a graph, left to right. Clicking a node shows its ledger record. */
export default function RunGraph({ records, run, onSelect }: RunGraphProps) {
  const reducedMotion = useReducedMotion();
  // Hidden until the first fit, so the graph does not show unfitted for a frame.
  const [fitted, setFitted] = useState(false);
  const graph = useMemo(() => runGraph(records, run), [records, run]);
  const nodes = useMemo<FlowNode[]>(() => {
    const at = layout(graph.nodes, graph.edges);
    return graph.nodes.map((node) => ({
      id: node.id,
      type: node.kind,
      position: at.get(node.id) ?? { x: 0, y: 0 },
      ...NODE_SIZE[node.kind],
      data: { node },
      ariaLabel: node.label,
      draggable: false,
      connectable: false,
    }));
  }, [graph]);
  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: "smoothstep",
        animated: edge.active && !reducedMotion,
        ...(edge.pending ? { style: { strokeDasharray: "4 4" } } : {}),
      })),
    [graph, reducedMotion],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        className={fitted ? undefined : "invisible"}
        onNodeClick={(_, node) => {
          const { recordId } = node.data.node;
          if (recordId) onSelect(recordId);
        }}
        minZoom={0.25}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Wheel and trackpad pan sideways; the page keeps its vertical scroll. Zoom with the
        // controls or a pinch.
        zoomOnScroll={false}
        zoomOnDoubleClick={false}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Horizontal}
        preventScrolling={false}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} orientation="horizontal" fitViewOptions={FIT} />
        <FitOnChange nodes={nodes} onFitted={() => setFitted(true)} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
