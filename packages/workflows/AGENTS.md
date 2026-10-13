# Working on @sanoma/workflows

This package owns workflow declarations, durable execution, policy and approval enforcement, and the ledger.

## Read when needed

- [README](README.md): public API, [resources](README.md#resources), and examples; [versions](README.md#versions) and [replay safety](README.md#keeping-workflows-replay-safe) for runtime changes.
- [Usage](README.md#usage): the config (`connectors`, `workflows`, `policy`) and its conventions; each connector carries its driver and fake (`withSetup`).
- [Scenarios and sandbox runs](README.md#scenarios-and-sandbox-runs): the Gherkin steps, the connectors' fakes and the root's `scenarios/`, and what a sandbox run does differently.
- [Source map](src/AGENTS.md): locate execution, definitions, analysis, or browser-safe helpers.
- [Test map](test/AGENTS.md): select coverage and the shared DBOS harness.

## Maintenance boundaries

- Keep policy checks, approvals, driver calls, and ledger records coordinated in `src/call.ts`. Changes to the durable call sequence require updating `STEP_LAYOUT` in `src/version.ts` so old runs do not replay against a new layout.
- Keep `src/shared.ts` browser-safe: no DBOS, Node, or zod imports. UI-facing descriptions belong in the describe entry point, not the execution path.
- The outline (`src/outline.ts`) is a contract, not a reading, and the one definition of what a workflow may write: `outlineBody` returns the nodes and the `problems` (what the graph cannot draw), `startWorker` and `lintWorkflow` both refuse on the problems (`describeConfig` lists them on each workflow's entry, with the import rules, reading each file once through `readSource`), and the worker places every `ctx` call in the nodes at run time (`src/call.ts` `placeCall`, the backstop for what no static reading sees, such as `arguments`). A new rule goes in `outlineBody`, with a test in `outline.test.ts` or `lint.test.ts` and, when the worker's refusal is what matters, `callsite.test.ts`.
- Keep `@sanoma/workflows/scenario` and `/scenarios` server-only: the shipped `oxlint.json` refuses them in workflow files, as it does `/fake`. `lint.ts` is internal (no `/lint` entry): `describeConfig` is how a problem reaches a UI or `sanoma check`, and `src/lint.ts` is what the tests and the oxlint plugin import. `src/sandbox.ts` is internal; the worker imports it dynamically, only for a sandbox run, so a live worker never loads gherkin or faker. The describe entry loads neither. Keep a sandbox run's seeding in its one checkpointed `sandbox:seed` step.
- Keep `RUNTIME_VERSION` aligned with the package version. Public export changes also affect consumers and the root source aliases. `allowImportNames` of the `@sanoma/workflows` entry in `oxlint.json` is the one list of names a workflow may import, from each package in `AUTHOR_PACKAGES` (`src/lint.ts`); the `sanoma` package derives its own entry from it at build and re-exports the list from `packages/sanoma/src/index.ts`, so a name added there is added to that index.
- `src/datafile.ts` is the one definition of the data-file subset: the reader, `lintResources` and the oxlint plugin all go through it, and `src/paths.ts` decides where an import may reach for both lints and the reader. The rule is configured only in the shipped `oxlint.json`, loaded from `dist/plugin.js`; the `./plugin` entry exports it for `sanoma`'s `oxlint.json`, which loads it from its own `dist/`.
- `src/drift.ts` is held to the workflow lint (a test lints it), so it imports no DBOS and makes no dynamic import: its data-file step is made in `src/config.ts` and passed in. The worker takes every definition, the built-in's too, from the running worker's config by name.
- Data files are found from the config's `root` (`defineConfig`'s call site, or set), never the working directory. The JSONL ledger's directory is still relative to the working directory: an inconsistency to fix, not a pattern to copy.
- The default ledger is `postgresLedger` on the config's database, with its table beside the credentials'; both go through `src/db.ts`. `resolveConfig` stays pure (the app calls it per request): `startWorker` and `SanomaClient` each make their own store (`ownedLedger` in `src/ledger.ts`) and are the only callers of `close`, which they call only on a store they made; a config's own `ledger` is never closed by the runtime.
- `resolveConfig` derives everything a config no longer says: each vendor's driver from its connector's setup, made once per resolution (`driversByVendor`, which `drivers` indexes and the credentials are read from), the makers of the fakes (`fakes`; `src/sandbox.ts` calls each once per sandbox run, and indexes that run's fakes itself), the app name from the nearest `package.json` at or above `root`, and `scenarios/` in `root`. A config setting `drivers`, `fakes`, `appName` or `scenarios` is refused. The setup is on the connector's `[VENDOR]` record, overlaid by `withSetup`; `setupOf` is internal (not exported), and `withSetup` stays off the workflow allow-list in `oxlint.json` and off `sanoma`'s author surface.
- The worker starts without credentials: `startWorker` warns per vendor, and `indexDrivers` in `src/config.ts` guards each function of a driver with an `env` so a call it does not satisfy fails inside the driver step as a final `DriverError`; a fake has no `env`, so sandbox runs are unguarded. Keep the check there (not at start, not before the policy or an approval hold), so stored credentials set later take effect on the next call and the refusal is the call's recorded failure.

## Checks

Run `pnpm vitest run packages/workflows` with Postgres from `pnpm db:up`, plus `pnpm typecheck` for the type-level tests. Build this package with `pnpm --filter @sanoma/workflows build` before building consumers.
