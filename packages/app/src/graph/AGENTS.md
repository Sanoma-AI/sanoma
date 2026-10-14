# packages/app/src/graph

Builds the workflow and run graphs and lays them out. No React here; `components/graph.tsx` draws the result.

## Contents

| Path                                     | What it is                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`layout.ts`](layout.ts)                 | Node sizes, and the dagre layout that places nodes and clusters and routes edges                 |
| [`outline-graph.ts`](outline-graph.ts)   | Turns steps into a graph with lanes for `ctx.all`, branches and labelled loops                   |
| [`run-graph.ts`](run-graph.ts)           | Builds a run's steps from its ledger and approvals, then its graph                               |
| [`scenario-graph.ts`](scenario-graph.ts) | Marks an outline's operations a scenario seeds, fails, expects or forbids, by id or by step name |
| [`types.ts`](types.ts)                   | Graph, node, edge and step types, `nodeAt` and `isSelectable`                                    |
| [`wildcard.ts`](wildcard.ts)             | A computed op id's header and rows (the operations it can reach), and their geometry             |

## Why dagre and not elkjs

#75 tried elkjs (layered, orthogonal routing, loops as compound nodes) in place of dagre and `steps()`. Its graphs read about as well (straighter main line, slightly narrower loops), but the graph chunk grew from 81 kB to 509 kB gzip; layout medians went from 0.2–1.4 ms to 3.4–6.0 ms per shape and became async; keeping lanes in member order (dagre's `disableOptimalOrderHeuristic`) needs a model-order strategy, and elkjs 0.12 throws a TypeError with `NODES_AND_EDGES` and `PREFER_NODES` inside a cluster with ports, leaving only `PREFER_EDGES`; and it would bundle code licensed EPL-2.0 OR GPL-3.0-or-later. `steps()` relies on dagre's undocumented edge ranks (an edge's points alternate edge rank and node rank, because dagre doubles `minlen` and halves `ranksep`): `steps()` throws, and the layout tests' `routeProblems` checks fail, if a dagre upgrade changes that.
