# packages/workflows/src

The source of `@sanoma/workflows`: how connectors, workflows and policies are declared, how a worker runs them durably on DBOS, and the tools that read them (lint, outline, describe). Its entry points, from `exports` in `package.json`: `.` (`index.ts`), `./describe`, `./fake`, `./lint`, `./scenario` and `./shared`.

## Contents

| Path                           | What it is                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`approvals.ts`](approvals.ts) | Approval events, decision messages and the durable wait for a decision                                |
| [`ast.ts`](ast.ts)             | Shared oxc parsing and tree walking for the lint and the outline                                      |
| [`call.ts`](call.ts)           | Builds a workflow's `ctx`: policy, approval, driver call and ledger write around each operation       |
| [`client.ts`](client.ts)       | `SanomaClient`: starts runs, lists them and decides approvals from outside the worker                 |
| [`config.ts`](config.ts)       | `SanomaConfig`, `defineConfig` and `resolveConfig`: what a worker runs, with which drivers and policy |
| [`define.ts`](define.ts)       | `defineWorkflow` and the types for principals, approvers, approval requests and built-ins             |
| [`describe.ts`](describe.ts)   | `describeConfig` and `outlineWorkflow`: the config as plain JSON for a UI                             |
| [`errors.ts`](errors.ts)       | Error codes, `SanomaError` and its subclasses, input parsing and `errorInfo`                          |
| [`fake.ts`](fake.ts)           | `defineFake`: fake vendors for tests                                                                  |
| [`index.ts`](index.ts)         | The main entry; re-exports the public API                                                             |
| [`ledger.ts`](ledger.ts)       | The audit record of a run, with JSONL and in-memory stores                                            |
| [`lint.ts`](lint.ts)           | `lintWorkflow`: import rules for workflow and policy files that oxlint cannot express                 |
| [`log.ts`](log.ts)             | Operator warnings and value formatting for messages                                                   |
| [`op.ts`](op.ts)               | `defineConnector`, operations, effects and drivers                                                    |
| [`outline.ts`](outline.ts)     | `outlineWorkflow`: the calls, loops, branches and `ctx.all` groups a workflow's `run` makes           |
| [`policy.ts`](policy.ts)       | Policy types, decisions (`allow`, `deny`, `approve`), `definePolicy` and `approvedFor`                |
| [`run.ts`](run.ts)             | The per-run and per-worker state the DBOS workflow receives                                           |
| [`sandbox.ts`](sandbox.ts)     | `seedSandbox`: a sandbox run's seeding of the fakes, which the worker imports only for such a run     |
| [`scenario.ts`](scenario.ts)   | Gherkin scenarios: `parseFeature`, `loadScenarios`, `check` and `drive`                               |
| [`shared.ts`](shared.ts)       | Browser-safe helpers for run status and approvals; no DBOS, Node or zod                               |
| [`version.ts`](version.ts)     | The package version, the step layout and `computeVersion`, the application version hash               |
| [`worker.ts`](worker.ts)       | `startWorker`: launches DBOS, registers the workflows and returns a stoppable `Worker`                |
