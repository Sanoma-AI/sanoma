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

## Maintenance boundaries

- Stay on dagre: [#75](https://github.com/Sanoma-AI/sanoma/issues/75) tried elkjs and rejected it (a much larger graph chunk, async and slower layout, EPL/GPL code); the measurements are in [#95](https://github.com/Sanoma-AI/sanoma/pull/95).
- `steps()` in `layout.ts` relies on dagre's undocumented edge ranks. If it throws, or `routeProblems` in `test/layout.test.ts` fails, after a dagre bump, dagre changed how it ranks edges; its comment says what it expects.
