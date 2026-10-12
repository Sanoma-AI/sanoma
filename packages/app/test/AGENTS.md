# packages/app/test

Vitest tests for `@sanoma/app`. They start the app against a real config and call its API and pages, and check the graph, form and loopback code on their own.

## Contents

| Path                                               | What it is                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`app.test.ts`](app.test.ts)                       | The API, error responses, pages (resources, drift and credentials too) and `startApp` options, against a running app |
| [`run-graph.test.ts`](run-graph.test.ts)           | `runGraph` from ledger records, with and without an outline                                                          |
| [`outline-graph.test.ts`](outline-graph.test.ts)   | `outlineGraph` for a workflow before it runs                                                                         |
| [`scenario-graph.test.ts`](scenario-graph.test.ts) | `annotateGraph` and `scenarioRoles`: a scenario's marks on an outline                                                |
| [`layout.test.ts`](layout.test.ts)                 | Graph layout: sequences, lanes, clusters and an op node sized by its rows                                            |
| [`wildcard.test.ts`](wildcard.test.ts)             | A computed op id's header and rows                                                                                   |
| [`schema.test.ts`](schema.test.ts)                 | The start form's schema code: fields, starting values, input, issue targets, and datetime-local values               |
| [`lines.test.ts`](lines.test.ts)                   | `highlightedLines` for the source panel                                                                              |
| [`loopback.test.ts`](loopback.test.ts)             | The loopback rule for Host names: `hostName`, then `isLoopback` from `@sanoma/workflows/shared`                      |
| [`fixtures/scenarios/`](fixtures/scenarios/)       | The feature file the app tests copy and read their scenarios from                                                    |
| [`graph-helpers.ts`](graph-helpers.ts)             | Edge and node helpers for the graph tests                                                                            |
