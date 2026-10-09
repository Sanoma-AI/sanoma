# packages/app/src/graph

Builds the workflow and run graphs and lays them out. No React here; `components/graph.tsx` draws the result.

## Contents

| Path                                     | What it is                                                            |
| ---------------------------------------- | --------------------------------------------------------------------- |
| [`layout.ts`](layout.ts)                 | Node sizes and the dagre layout that places nodes and clusters        |
| [`outline-graph.ts`](outline-graph.ts)   | Turns steps into a graph with lanes for `ctx.all`, branches and loops |
| [`run-graph.ts`](run-graph.ts)           | Builds a run's steps from its ledger and approvals, then its graph    |
| [`scenario-graph.ts`](scenario-graph.ts) | Marks an outline's operations a scenario seeds or expects             |
| [`types.ts`](types.ts)                   | Graph, node, edge and step types                                      |
