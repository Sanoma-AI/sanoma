// React Flow's stylesheet, once, in this chunk: only the pages with a graph load it. style.css
// maps its --xy-* colours to the theme.
// oxlint-disable-next-line import/no-unassigned-import
import "@xyflow/react/dist/style.css";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Background,
  Controls,
  type Edge,
  getNodesBounds,
  Handle,
  type Node,
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
import { approverLabel } from "@sanoma/workflows/shared";
import { layout } from "../graph/layout.ts";
import { type Graph as GraphData, type GraphNode, type GraphNodeKind, isPending } from "../graph/types.ts";
import { configQuery, opsById } from "../queries.ts";
import { APPROVAL_TONE, DECISION_TONE, effectBadge, StatusDot, type Tone, toneBadge } from "./common.tsx";

// A run's graph, or a workflow's outline, drawn with React Flow. It needs the DOM, so the pages
// load this module only in the browser (GraphPanel in common.tsx: React.lazy behind ClientOnly);
// the server renders a skeleton instead.

type FlowNode = Node<{ node: GraphNode }, GraphNodeKind>;
/** What a node component reads of its `NodeProps`: its node, of its kind. */
type Props<K extends GraphNodeKind> = { data: { node: Extract<GraphNode, { kind: K }> } };

/** How the view fits the graph (the controls' fit button fits all of it). */
const FIT = { padding: 0.1, minZoom: 0.25, maxZoom: 1 } as const;
/** Below this zoom the badges cannot be read: fit one end of the graph instead of all of it. */
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
  "flex size-full flex-col justify-center gap-1 rounded-lg border bg-card px-2.5 text-xs text-card-foreground shadow-xs transition-colors",
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
      pending: { true: "border-dashed bg-transparent text-muted-foreground" },
      // It has a ledger record to show.
      clickable: { true: "cursor-pointer hover:bg-muted" },
    },
  },
);

/** Where edges meet a node: hidden, since nothing connects by hand here. */
function Handles({ inbound = true, outbound = true }: { inbound?: boolean; outbound?: boolean }) {
  return (
    <>
      {inbound && <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />}
      {outbound && <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />}
    </>
  );
}

/** One node's box, in its tone when a run gives it one, with its handles. */
function Frame({
  node,
  inbound,
  outbound,
  children,
}: {
  node: GraphNode;
  inbound?: boolean;
  outbound?: boolean;
  children: ReactNode;
}) {
  const state = "state" in node ? node.state : undefined;
  return (
    <div
      className={frame({ tone: state?.tone ?? "off", pending: isPending(node), clickable: !!state?.recordId })}
      title={node.label}
    >
      <Handles inbound={inbound} outbound={outbound} />
      {children}
    </div>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-1.5">{children}</div>;
}

/** The node's tone, when a run gives it one. */
const Dot = ({ tone }: { tone: Tone | undefined }) => tone && <StatusDot tone={tone} />;

function StartNode({ data: { node } }: Props<"start">) {
  return (
    <Frame node={node} inbound={false}>
      <Line>
        <Dot tone={node.state?.tone} />
        {node.label}
      </Line>
    </Frame>
  );
}

function EndNode({ data: { node } }: Props<"end">) {
  return (
    <Frame node={node} outbound={false}>
      <Line>
        <Dot tone={node.state?.tone} />
        {node.label}
      </Line>
    </Frame>
  );
}

function OpNode({ data: { node } }: Props<"op">) {
  // The effect is the config's: a call still held for its approval has no record yet.
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const effect = ops.get(node.label)?.effect;
  const { state } = node;
  const held = state?.approval && state.decision === undefined ? state.approval : undefined;
  return (
    <Frame node={node}>
      <Line>
        <Dot tone={state?.tone} />
        <code className="truncate">{node.label}</code>
      </Line>
      <Line>
        {effect && <Badge className={effectBadge({ effect })}>{effect}</Badge>}
        {held ? (
          <Badge className={toneBadge({ tone: APPROVAL_TONE[held.status] })} title={held.title}>
            {held.status === "pending" ? `held · ${approverLabel(held.approver)}` : held.status}
          </Badge>
        ) : (
          state?.decision && (
            <Badge className={toneBadge({ tone: DECISION_TONE[state.decision] })}>{state.decision}</Badge>
          )
        )}
        {state?.errorCode ? (
          <span className="truncate text-destructive">{state.errorCode}</span>
        ) : (
          state?.durationMs !== undefined && <span className="text-muted-foreground">{state.durationMs} ms</span>
        )}
      </Line>
    </Frame>
  );
}

function ApprovalNode({ data: { node } }: Props<"approval">) {
  const approval = node.state?.approval;
  return (
    <Frame node={node}>
      <Line>
        <Dot tone={node.state?.tone} />
        <span className="truncate">{node.label}</span>
      </Line>
      {approval && (
        <Line>
          <Badge className={toneBadge({ tone: APPROVAL_TONE[approval.status] })}>{approval.status}</Badge>
          <span className="truncate text-muted-foreground">{approverLabel(approval.approver)}</span>
        </Line>
      )}
    </Frame>
  );
}

/** A sleep, and in a run when it ends (UTC, as the ledger shows it). */
function SleepNode({ data: { node } }: Props<"sleep">) {
  return (
    <Frame node={node}>
      <Line>
        <Dot tone={node.state?.tone} />
        <span className="truncate">{node.label}</span>
      </Line>
    </Frame>
  );
}

/** A `ctx.all` member the run has recorded nothing for yet, drawn like the end it has not reached. */
function PendingNode({ data: { node } }: Props<"pending">) {
  return (
    <Frame node={node}>
      <Line>{node.label}</Line>
    </Frame>
  );
}

/** A box around the nodes it holds (a loop's body, a computed `ctx.all`'s member), named by a badge. */
function ClusterNode({ data: { node } }: Props<"cluster">) {
  return (
    <div className="size-full rounded-lg border border-dashed border-muted-foreground/40" title={node.label}>
      <Handles />
      <Badge variant="outline" className="m-1.5 bg-card">
        {node.label}
      </Badge>
    </div>
  );
}

/** Where a branch splits: a small diamond. */
function SplitNode() {
  return (
    <div className="flex size-full items-center justify-center" title="branch">
      <Handles />
      <div className="size-4 rotate-45 rounded-xs border border-muted-foreground/60 bg-card" />
    </div>
  );
}

const nodeTypes = {
  start: StartNode,
  end: EndNode,
  op: OpNode,
  approval: ApprovalNode,
  sleep: SleepNode,
  pending: PendingNode,
  cluster: ClusterNode,
  split: SplitNode,
} satisfies { [K in GraphNodeKind]: (props: Props<K>) => ReactNode } as NodeTypes;

/** Fits the view again when nodes come or go, as the run's page polls. */
function FitOnChange({ nodes, show, onFitted }: { nodes: FlowNode[]; show: "start" | "end"; onFitted: () => void }) {
  const { fitView, setViewport } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const count = nodes.length;
  useEffect(() => {
    if (!width || !height || !count) return;
    // A cluster's nodes are placed relative to it, and inside it.
    const bounds = getNodesBounds(nodes.filter((n) => n.parentId === undefined));
    // All of the graph when it fits at a readable zoom. Else one end at that zoom (a run's
    // latest steps, an outline's first); panning shows the rest.
    const fits = bounds.width * READABLE_ZOOM <= width * (1 - 2 * FIT.padding);
    const done = fits
      ? fitView(FIT)
      : setViewport({
          zoom: READABLE_ZOOM,
          x:
            show === "start"
              ? width * FIT.padding - bounds.x * READABLE_ZOOM
              : width * (1 - FIT.padding) - (bounds.x + bounds.width) * READABLE_ZOOM,
          y: height / 2 - (bounds.y + bounds.height / 2) * READABLE_ZOOM,
        });
    void done.then(onFitted);
    // Only when nodes come or go, or the view resizes: not on every poll.
  }, [count, width, height, fitView, setViewport]);
  return null;
}

export interface GraphProps {
  graph: GraphData;
  /** Called with a clicked node's ledger record id. Nodes without a record do nothing. */
  onSelect?: (recordId: string) => void;
  /** The end shown when all of the graph cannot be read at once. Defaults to `end`. */
  show?: "start" | "end";
}

/** A graph, left to right. Clicking a node with a ledger record calls `onSelect` with it. */
export default function Graph({ graph, onSelect, show = "end" }: GraphProps) {
  const reducedMotion = useReducedMotion();
  // Hidden until the first fit, so the graph does not show unfitted for a frame.
  const [fitted, setFitted] = useState(false);
  const nodes = useMemo(() => {
    const at = layout(graph);
    // A cluster comes before the nodes inside it, as React Flow needs.
    return graph.nodes.map((node) => {
      const { x, y, ...size } = at.get(node.id)!;
      return {
        id: node.id,
        type: node.kind,
        position: { x, y },
        ...size,
        ...(node.parent === undefined ? {} : { parentId: node.parent }),
        data: { node },
        ariaLabel: node.label,
        draggable: false,
        connectable: false,
      } as FlowNode;
    });
  }, [graph]);
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.map(({ id, source, target }) => {
      const from = byId.get(source)!;
      const to = byId.get(target)!;
      // Moving into what is in flight; dashed into and out of what the run has not reached.
      const active = "state" in to && to.state?.tone === "active";
      return {
        id,
        source,
        target,
        type: "smoothstep",
        animated: active && !reducedMotion,
        ...(isPending(from) || isPending(to) ? { style: { strokeDasharray: "4 4" } } : {}),
      };
    });
  }, [graph, reducedMotion]);

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        className={fitted ? undefined : "invisible"}
        onNodeClick={(_, node: FlowNode) => {
          const recordId = "state" in node.data.node ? node.data.node.state?.recordId : undefined;
          if (recordId) onSelect?.(recordId);
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
        <FitOnChange nodes={nodes} show={show} onFitted={() => setFitted(true)} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
