# packages/workflows/test

Vitest tests for `@sanoma/workflows`. Files that start runs need Postgres (`pnpm db:up`) and use the shared harness; the rest are unit tests.

## Contents

| Path                                     | What it is                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`bad-data-files.ts`](bad-data-files.ts) | Data files outside the subset, one construct each, for the lint and reader tests                         |
| [`fixtures/`](fixtures/)                 | Example workflows; `company/`, a config with data files in its `resources/`, and fakes holding them      |
| [`announce.test.ts`](announce.test.ts)   | The announce workflow end to end: approvals, sleep, restart and policy holds                             |
| [`approvals.test.ts`](approvals.test.ts) | `approvedFor`, `mayDecide`, and approvals a workflow or a policy asks for, on Postgres                   |
| [`build.ts`](build.ts)                   | `ensureBuilt`: builds dist/ when missing or stale, for tests of what the package ships                   |
| [`call.test.ts`](call.test.ts)           | How calls run: failures, retries, restarts, `ctx.sleep`, the policy's view and `ctx.all`                 |
| [`client.test.ts`](client.test.ts)       | `runStatus`, `firstMatching` and `SanomaClient` against Postgres                                         |
| [`define.test.ts`](define.test.ts)       | `defineWorkflow` records the file that called it                                                         |
| [`describe.test.ts`](describe.test.ts)   | `describeConfig`: workflows, operations, vendors and policy                                              |
| [`drift.test.ts`](drift.test.ts)         | The built-in drift workflow on `useApp` and the company fakes: its report, ledger, references and record |
| [`errors.test.ts`](errors.test.ts)       | `errorCode` and `errorInfo`                                                                              |
| [`harness.ts`](harness.ts)               | Shared setup: fake vendors, a started worker and client, and wait helpers                                |
| [`ledger.test.ts`](ledger.test.ts)       | The in-memory and JSONL ledgers, and how a run writes its records                                        |
| [`lint.test.ts`](lint.test.ts)           | `lintWorkflow`, `lintResources` and the shipped `oxlint.json`, with its data-file plugin                 |
| [`outline.test.ts`](outline.test.ts)     | `outlineWorkflow`: nodes, spans and fallbacks, from source and built JavaScript                          |
| [`resource.test.ts`](resource.test.ts)   | `defineResource` and references, `compareDeclared`, `diffDeclared`, resource types in `describeConfig`   |
| [`resources.test.ts`](resources.test.ts) | The data-file reader and its problems, `describeConfig`'s, and `resolveConfig`'s `root`                  |
| [`types.test.ts`](types.test.ts)         | Type-level checks for drivers, operation ids and workflow names, run by `pnpm typecheck`                 |
| [`version.test.ts`](version.test.ts)     | The application version, and workers on one database: versions, queues and rollbacks                     |
| [`worker.test.ts`](worker.test.ts)       | `startWorker` and `resolveConfig` refusals, derived settings, and failure after launch                   |
