# packages/workflows/src

The source of `@sanoma/workflows`: how connectors, workflows and policies are declared, how a worker runs them durably on DBOS, and the tools that read them (lint, outline, describe). Its entry points, from `exports` in `package.json`: `.` (`index.ts`), `./describe`, `./fake`, `./lint` and `./shared`.

## Contents

| Path                           | What it is                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [`approvals.ts`](approvals.ts) | Approval events, decision messages and the durable wait for a decision                                |
| [`ast.ts`](ast.ts)             | Shared oxc parsing, tree walking, line numbers and syntax problems for the lints, outline and reader  |
| [`call.ts`](call.ts)           | Builds a workflow's `ctx`: policy, approval, driver call and ledger write around each operation       |
| [`client.ts`](client.ts)       | `SanomaClient`: starts runs, lists them and decides approvals from outside the worker                 |
| [`config.ts`](config.ts)       | `SanomaConfig`, `defineConfig` and `resolveConfig`: what a worker runs, with which drivers and policy |
| [`datafile.ts`](datafile.ts)   | `readDataFile`: the data-file subset over an oxc ESTree program, for the reader and both lints        |
| [`define.ts`](define.ts)       | `defineWorkflow` and the types for principals, approvers, approval requests and built-ins             |
| [`describe.ts`](describe.ts)   | `describeConfig` and `outlineWorkflow`, re-exporting the reader: the config as plain JSON for a UI    |
| [`errors.ts`](errors.ts)       | Error codes, `SanomaError` and its subclasses, input parsing and `errorInfo`                          |
| [`fake.ts`](fake.ts)           | `defineFake`: fake vendors for tests                                                                  |
| [`index.ts`](index.ts)         | The main entry; re-exports the public API                                                             |
| [`ledger.ts`](ledger.ts)       | The audit record of a run, with JSONL and in-memory stores                                            |
| [`lint.ts`](lint.ts)           | `lintWorkflow` (import rules oxlint cannot express) and `lintResources` (the data-file subset)        |
| [`log.ts`](log.ts)             | Operator warnings and value formatting for messages                                                   |
| [`op.ts`](op.ts)               | `defineConnector`, operations, effects and drivers                                                    |
| [`outline.ts`](outline.ts)     | `outlineWorkflow`: the calls, loops, branches and `ctx.all` groups a workflow's `run` makes           |
| [`plugin.ts`](plugin.ts)       | The oxlint JS plugin `sanoma`, its rule `data-file`; `oxlint.json` loads it from `dist/`              |
| [`paths.ts`](paths.ts)         | Where a relative import may reach: `nearestDir` and `inside`, for both lints and the reader           |
| [`policy.ts`](policy.ts)       | Policy types, decisions (`allow`, `deny`, `approve`), `definePolicy` and `approvedFor`                |
| [`resource.ts`](resource.ts)   | `defineResource`: a resource type's schema, fields, identity, constructor, and `read` and `import`    |
| [`resources.ts`](resources.ts) | `readDataFiles` and `readResources`: the resources the data files declare, and their problems         |
| [`run.ts`](run.ts)             | The per-run and per-worker state the DBOS workflow receives                                           |
| [`shared.ts`](shared.ts)       | Browser-safe helpers for run status and approvals, and resource types; no DBOS, Node or zod           |
| [`version.ts`](version.ts)     | The package version, the step layout and `computeVersion`, the application version hash               |
| [`worker.ts`](worker.ts)       | `startWorker`: launches DBOS, registers the workflows and returns a stoppable `Worker`                |
