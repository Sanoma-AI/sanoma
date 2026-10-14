import { useSuspenseQuery } from "@tanstack/react-query";
import {
  Background,
  BaseEdge,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
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
import type { OpEntry } from "@sanoma/workflows/describe";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { approverLabel } from "@sanoma/workflows/shared";
import { layout, type Point } from "../graph/layout.ts";
import {
  type Graph as GraphData,
  type GraphNode,
  type GraphNodeKind,
  isPending,
  isSelectable,
} from "../graph/types.ts";
import { MAX_VENDORS, wildcardHeader, wildcardRows } from "../graph/wildcard.ts";
import { useReducedMotion } from "#/lib/motion.ts";
import { cn } from "#/lib/utils.ts";
import { APPROVAL_TONE, DECISION_TONE, type Tone } from "#/lib/tone.ts";
import { configQuery, opsById } from "../queries.ts";
import { BaseNode } from "./base-node.tsx";
import { ApprovalStatusBadge, BUILTIN_ICON, effectBadge, StatusDot, ToneBadge, VendorLogo } from "./common.tsx";
import { ZoomSlider } from "./zoom-slider.tsx";

// A run's graph, or a workflow's outline, drawn with React Flow. It needs the DOM, so the pages
// load this module only in the browser (GraphPanel in common.tsx: React.lazy, once seen);
// the server renders a skeleton instead.

/** A node as React Flow holds it: the graph's node, and whether a click on it selects it. */
type FlowNode = Node<{ node: GraphNode; selectable: boolean }, GraphNodeKind>;
/** An edge as React Flow holds it: the route `layout` gives it, as an SVG path. */
type FlowEdge = Edge<{ path: string }, "route">;
/** What a node component reads of its `NodeProps`: its node, of its kind, and whether it is selected. */
type Props<K extends GraphNodeKind> = {
  data: { node: Extract<GraphNode, { kind: K }>; selectable: boolean };
  selected: boolean;
};

/**
 * The room the view leaves around the graph, in px. Below it, the zoom slider's: its panel sits
 * 15 px from the bottom edge and is 42 px high (size-8 buttons, p-1 and a border), and no node
 * goes under it, at any width.
 */
const PAD = { x: 24, top: 16, bottom: 64 } as const;
/** How the view fits the graph (the zoom slider's fit button fits all of it). */
const FIT = {
  padding: { x: `${PAD.x}px`, top: `${PAD.top}px`, bottom: `${PAD.bottom}px` },
  minZoom: 0.25,
  maxZoom: 1,
} as const;
/** No "React Flow" link in the corner of each graph. */
const PRO_OPTIONS = { hideAttribution: true };

/** Below this zoom the badges cannot be read: fit one end of the graph instead of all of it. */
const READABLE_ZOOM = 0.8;

// BaseNode's look with the graph's: its card, at the layout's size, rounder, without its hover
// ring (a click selects only some nodes, and those turn muted under the pointer instead).
const frame = cva(
  "flex size-full flex-col justify-center gap-1 rounded-lg px-2.5 text-xs shadow-xs transition-colors hover:ring-0",
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
      // A click selects it.
      clickable: { true: "cursor-pointer hover:bg-muted" },
      // Ringed, under the pointer too; BaseNode adds its shadow and border for React Flow's flag.
      selected: { true: "ring-2 ring-ring hover:ring-2" },
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

/**
 * What a node is called, for its title and assistive tech: its label, but for a run's sleep,
 * whose label says only until when and whose clock says "sleep", and an operation with a name,
 * which says both.
 */
const nameOf = (node: GraphNode) => {
  if (node.kind === "sleep") {
    const clock = node.state ? `sleep ${node.label}` : node.label;
    return node.name ? `${node.name}: ${clock}` : clock;
  }
  return node.kind === "op" && node.name ? `${node.name}: ${node.label}` : node.label;
};

/**
 * One node's box, React Flow UI's BaseNode: in its tone when a run gives it one, ringed when
 * selected, with its handles.
 */
function Frame({
  data: { node, selectable },
  selected,
  inbound,
  outbound,
  children,
}: Props<GraphNodeKind> & { inbound?: boolean; outbound?: boolean; children: ReactNode }) {
  const state = "state" in node ? node.state : undefined;
  return (
    <BaseNode
      // Through cn, so a pending node's colours replace the base ones rather than sit beside them.
      className={cn(frame({ tone: state?.tone ?? "off", pending: isPending(node), clickable: selectable, selected }))}
      title={nameOf(node)}
      // React Flow's node around it takes focus, named: not this box as well.
      tabIndex={undefined}
    >
      <Handles inbound={inbound} outbound={outbound} />
      {children}
    </BaseNode>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 items-center gap-1.5">{children}</div>;
}

/** The node's tone, when a run gives it one. */
const Dot = ({ tone }: { tone: Tone | undefined }) => tone && <StatusDot tone={tone} />;

function StartNode(props: Props<"start">) {
  const { node } = props.data;
  return (
    <Frame {...props} inbound={false}>
      <Line>
        <Dot tone={node.state?.tone} />
        {node.label}
      </Line>
    </Frame>
  );
}

function EndNode(props: Props<"end">) {
  const { node } = props.data;
  return (
    <Frame {...props} outbound={false}>
      <Line>
        <Dot tone={node.state?.tone} />
        {node.label}
      </Line>
    </Frame>
  );
}

/** The config's operations by id, read once for the whole graph. */
const Ops = createContext<Map<string, OpEntry>>(new Map());

/** A vendor's name in a logo's place, for a vendor the config has no logo for. */
const vendorName = (vendor: string) => <span className="shrink-0 text-muted-foreground">{vendor}</span>;

/**
 * The operations an op node stands for (its `ops`, else the one its label names) as what the
 * config says of them: their distinct vendors, and the effect they share, if they share one. The
 * effect is the config's, as a call still held for its approval has no record yet.
 */
function useOpFacts(node: Extract<GraphNode, { kind: "op" }>) {
  const ops = use(Ops);
  return useMemo(() => {
    const reach = (node.ops ?? [node.label]).map((id) => ops.get(id)).filter((op) => op !== undefined);
    const effects = new Set(reach.map((op) => op.effect));
    return {
      vendors: [...new Set(reach.map((op) => op.vendor))],
      effect: effects.size === 1 ? [...effects][0] : undefined,
    };
  }, [node.ops, node.label, ops]);
}

/**
 * An operation. One with a name says it first, its id on the line below. One with `ops` (an
 * outline's call with a computed segment) is a stacked list: what is literal in its id, then a
 * row per operation it can reach (`wildcardRows`).
 */
function OpNode(props: Props<"op">) {
  const { node } = props.data;
  const { vendors, effect } = useOpFacts(node);
  const { state } = node;
  const held = state?.approval && state.decision === undefined ? state.approval : undefined;
  return (
    <Frame {...props}>
      <Line>
        <Dot tone={state?.tone} />
        {vendors.slice(0, MAX_VENDORS).map((vendor) => (
          <VendorLogo key={vendor} vendor={vendor} fallback={vendorName(vendor)} />
        ))}
        {vendors.length > MAX_VENDORS && (
          <span className="shrink-0 text-muted-foreground">+{vendors.length - MAX_VENDORS}</span>
        )}
        {node.name ? (
          <span className="truncate font-medium">{node.name}</span>
        ) : (
          <code className="truncate">{node.ops ? wildcardHeader(node.label) : node.label}</code>
        )}
      </Line>
      {node.name && (
        <Line>
          <code className="truncate text-muted-foreground">{node.ops ? wildcardHeader(node.label) : node.label}</code>
        </Line>
      )}
      <Line>
        {effect && <Badge className={effectBadge({ effect })}>{effect}</Badge>}
        {held ? (
          <ToneBadge tone={APPROVAL_TONE[held.status]} title={held.title}>
            {held.status === "pending" ? `held · ${approverLabel(held.approver)}` : held.status}
          </ToneBadge>
        ) : (
          state?.decision && <ToneBadge tone={DECISION_TONE[state.decision]}>{state.decision}</ToneBadge>
        )}
        {state?.errorCode ? (
          <span className="truncate text-destructive">{state.errorCode}</span>
        ) : (
          state?.durationMs !== undefined && <span className="text-muted-foreground">{state.durationMs} ms</span>
        )}
        {state?.scenario?.seeded && <Badge variant="outline">seeded</Badge>}
        {state?.scenario?.fails && <Badge variant="outline">fails</Badge>}
        {state?.scenario?.expected && <Badge variant="outline">expected</Badge>}
        {state?.scenario?.forbidden && <Badge variant="outline">not called</Badge>}
        {state?.scenario?.denied && <Badge variant="outline">must deny</Badge>}
        {state?.scenario?.held && <Badge variant="outline">must hold</Badge>}
      </Line>
      {node.ops && <Separator />}
      {node.ops && (
        <ul className="flex flex-col gap-0.5" aria-label="operations it can reach">
          {wildcardRows(node.label, node.ops).map((row) =>
            "note" in row ? (
              <li key={row.note} className="text-muted-foreground">
                {row.note}
              </li>
            ) : (
              <li key={row.id} className="flex min-w-0 items-center gap-1.5" title={row.id}>
                <VendorLogo vendor={row.vendor} fallback={vendorName(row.vendor)} />
                <code className="truncate">{row.label}</code>
              </li>
            ),
          )}
        </ul>
      )}
    </Frame>
  );
}

function ApprovalNode(props: Props<"approval">) {
  const { node } = props.data;
  const approval = node.state?.approval;
  return (
    <Frame {...props}>
      <Line>
        <Dot tone={node.state?.tone} />
        <BUILTIN_ICON.approval className="size-4 shrink-0" />
        <span className="truncate">{node.label}</span>
      </Line>
      {approval && (
        <Line>
          <ApprovalStatusBadge status={approval.status} />
          <span className="truncate text-muted-foreground">{approverLabel(approval.approver)}</span>
        </Line>
      )}
    </Frame>
  );
}

/**
 * A sleep, and in a run when it ends (UTC, as the ledger shows it). One with a name says it
 * first, as an operation does, the clock and its time on the line below.
 */
function SleepNode(props: Props<"sleep">) {
  const { node } = props.data;
  const clock = (
    <>
      <BUILTIN_ICON.sleep className="size-4 shrink-0" />
      <span className={cn("truncate", node.name && "text-muted-foreground")}>{node.label}</span>
    </>
  );
  return (
    <Frame {...props}>
      <Line>
        <Dot tone={node.state?.tone} />
        {node.name ? <span className="truncate font-medium">{node.name}</span> : clock}
      </Line>
      {node.name && <Line>{clock}</Line>}
    </Frame>
  );
}

/** A `ctx.all` member the run has recorded nothing for yet: "not started", dashed like the open end. */
function PendingNode(props: Props<"pending">) {
  const { node } = props.data;
  return (
    <Frame {...props}>
      <Line>{node.label}</Line>
    </Frame>
  );
}

/** A box around the nodes it holds (a loop's body, a computed `ctx.all`'s member), named by a badge. */
function ClusterNode({ data: { node } }: Props<"cluster">) {
  return (
    <div className="size-full rounded-lg border border-dashed border-muted-foreground/40" title={node.label}>
      <Handles />
      {/* Inside the box however long the label: the title above has it whole. */}
      <Badge variant="outline" className="m-1.5 max-w-[calc(100%-12px)] bg-card">
        <span className="min-w-0 truncate">{node.label}</span>
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

/** A branch's way past its cases: a label on its own lane, so the lane shows. */
function SkipNode({ data: { node } }: Props<"skip">) {
  return (
    <div className="flex size-full items-center justify-center" title={node.label}>
      <Handles />
      <Badge variant="outline" className="bg-card text-muted-foreground">
        {node.label}
      </Badge>
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
  skip: SkipNode,
} satisfies { [K in GraphNodeKind]: (props: Props<K>) => ReactNode } as NodeTypes;

/** How round a route's corners are, in px: React Flow's smoothstep edges' default borderRadius. */
const CORNER = 5;

/** The point `d` px from `from` towards `to`, along a run across or down. */
const towards = (from: Point, to: Point, d: number): Point => ({
  x: from.x + Math.sign(to.x - from.x) * d,
  y: from.y + Math.sign(to.y - from.y) * d,
});

/** A run's length: it goes across or down, not both. */
const run = (a: Point, b: Point) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y);

/**
 * A route as an SVG path: its runs straight, each corner rounded by CORNER, or by half the shorter
 * run it joins, as xyflow's smoothstep does (its getBend, which it does not export).
 */
function pathOf(route: readonly Point[]): string {
  let path = `M ${route[0]!.x} ${route[0]!.y}`;
  for (let i = 1; i < route.length - 1; i++) {
    const [before, point, after] = [route[i - 1]!, route[i]!, route[i + 1]!];
    const r = Math.min(CORNER, run(before, point) / 2, run(point, after) / 2);
    const [into, out] = [towards(point, before, r), towards(point, after, r)];
    path += ` L ${into.x} ${into.y} Q ${point.x} ${point.y} ${out.x} ${out.y}`;
  }
  const last = route.at(-1)!;
  return `${path} L ${last.x} ${last.y}`;
}

/**
 * An edge along the route `layout` gave it, rather than one React Flow draws between its
 * handles: a step React Flow puts halfway between them runs behind a wider node beside the target.
 * Its ends are the layout's, which are React Flow's too: each node is drawn at its layout box's
 * width and height.
 */
function RouteEdge({ data, style, interactionWidth }: EdgeProps<FlowEdge>) {
  return <BaseEdge path={data!.path} style={style} interactionWidth={interactionWidth} />;
}

const edgeTypes = { route: RouteEdge } satisfies EdgeTypes;

/**
 * An edge into or out of what the run has not reached: its path dashed. The class is the edge's,
 * on the group around its path; raw, so Tailwind reads `\_` as an underscore, not a space.
 */
const DASHED = String.raw`[&_.react-flow\_\_edge-path]:[stroke-dasharray:4_4]`;

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
    const room = { width: width - 2 * PAD.x, height: height - PAD.top - PAD.bottom };
    // All of the graph when it fits at a readable zoom. Else one end (a run's latest steps, an
    // outline's first) at that zoom, or less if its lanes are taller than the room; panning
    // shows the rest.
    const zoom = Math.max(FIT.minZoom, Math.min(READABLE_ZOOM, room.height / bounds.height));
    const done =
      bounds.width * READABLE_ZOOM <= room.width
        ? fitView(FIT)
        : setViewport({
            zoom,
            x: show === "start" ? PAD.x - bounds.x * zoom : width - PAD.x - (bounds.x + bounds.width) * zoom,
            y: PAD.top + room.height / 2 - (bounds.y + bounds.height / 2) * zoom,
          });
    void done.then(onFitted);
    // Only when nodes come or go, or the view resizes: not on every poll.
  }, [count, width, height, fitView, setViewport]);
  return null;
}

/** Equal, objects compared key by key down to `depth` levels. */
function same(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const [x, y] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((key) => same(x[key], y[key], depth - 1));
}

/**
 * The items, each replaced by the last render's of its id when that is the same down to `depth`
 * levels, so React Flow redraws only what a poll changed.
 */
function useStable<T extends { id: string }>(items: T[], depth: number): T[] {
  const last = useRef(new Map<string, T>());
  return useMemo(() => {
    const stable = items.map((item) => {
      const before = last.current.get(item.id);
      return before && same(before, item, depth) ? before : item;
    });
    last.current = new Map(stable.map((item) => [item.id, item]));
    return stable;
  }, [items, depth]);
}

export interface GraphProps {
  /** Built by the page, which needs its nodes too: a click in the source finds its node there. */
  graph: GraphData;
  /** The end shown when all of the graph cannot be read at once. Defaults to `end`. */
  show?: "start" | "end";
  /** The selected node's id, ringed. */
  selected?: string | undefined;
  /** Called with a clicked node that has a place in the source or a ledger record. Others do nothing. */
  onSelect?: (node: GraphNode) => void;
}

/**
 * A graph, laid out and drawn left to right, here in the browser. Clicking a node with a place in
 * the source or a ledger record calls `onSelect` with it.
 */
export default function Graph({ graph, show = "end", selected, onSelect }: GraphProps) {
  const reducedMotion = useReducedMotion();
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  // Hidden until the first fit, so the graph does not show unfitted for a frame.
  const [fitted, setFitted] = useState(false);
  const clickable = onSelect !== undefined;
  const at = useMemo(() => layout(graph), [graph]);
  const laidOut = useMemo(() => {
    // A cluster comes before the nodes inside it, as React Flow needs.
    return graph.nodes.map((node) => {
      const { x, y, ...size } = at.boxes.get(node.id)!;
      return {
        id: node.id,
        type: node.kind,
        position: { x, y },
        ...size,
        ...(node.parent === undefined ? {} : { parentId: node.parent }),
        data: { node, selectable: clickable && isSelectable(node) },
        ariaLabel: nameOf(node),
        draggable: false,
        connectable: false,
      } as FlowNode;
    });
  }, [graph, at, clickable]);
  // A node down to its state's fields; the approval on it is the query's, kept when unchanged.
  const stable = useStable(laidOut, 4);
  // React Flow's own flag rings the selected node: only the nodes it moves from and to change.
  const nodes = useMemo(
    () => stable.map((node) => (node.id === selected ? { ...node, selected: true } : node)),
    [stable, selected],
  );
  const drawn = useMemo<FlowEdge[]>(() => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.map((edge) => {
      const from = byId.get(edge.source)!;
      const to = byId.get(edge.target)!;
      // Moving into what is in flight; dashed into and out of what the run has not reached.
      const active = "state" in to && to.state?.tone === "active";
      return {
        ...edge,
        type: "route",
        data: { path: pathOf(at.routes.get(edge.id)!) },
        animated: active && !reducedMotion,
        ...(isPending(from) || isPending(to) ? { className: DASHED } : {}),
      };
    });
  }, [graph, at, reducedMotion]);
  // An edge down to its path.
  const edges = useStable(drawn, 2);
  const onNodeClick = useCallback(
    (_: unknown, { data }: FlowNode) => {
      if (data.selectable) onSelect?.(data.node);
    },
    [onSelect],
  );

  return (
    <ReactFlowProvider>
      <Ops value={ops}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          className={fitted ? undefined : "invisible"}
          onNodeClick={onNodeClick}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // Wheel and trackpad pan sideways; the page keeps its vertical scroll. Zoom with the
          // zoom slider or a pinch.
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Horizontal}
          preventScrolling={false}
          proOptions={PRO_OPTIONS}
        >
          <Background gap={16} size={1} />
          <ZoomSlider position="bottom-left" fitViewOptions={FIT} duration={reducedMotion ? 0 : 300} />
          <FitOnChange nodes={nodes} show={show} onFitted={() => setFitted(true)} />
        </ReactFlow>
      </Ops>
    </ReactFlowProvider>
  );
}
