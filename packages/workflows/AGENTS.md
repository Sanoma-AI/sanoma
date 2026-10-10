# Working on @sanoma/workflows

This package owns workflow declarations, durable execution, policy and approval enforcement, and the ledger.

## Read when needed

- [README](README.md): public API, [resources](README.md#resources), and examples; [versions](README.md#versions) and [replay safety](README.md#keeping-workflows-replay-safe) for runtime changes.
- [Scenarios and sandbox runs](README.md#scenarios-and-sandbox-runs): the Gherkin steps, the `fakes` and `scenarios` config, and what a sandbox run does differently.
- [Source map](src/AGENTS.md): locate execution, definitions, analysis, or browser-safe helpers.
- [Test map](test/AGENTS.md): select coverage and the shared DBOS harness.

## Maintenance boundaries

- Keep policy checks, approvals, driver calls, and ledger records coordinated in `src/call.ts`. Changes to the durable call sequence require updating `STEP_LAYOUT` in `src/version.ts` so old runs do not replay against a new layout.
- Keep `src/shared.ts` browser-safe: no DBOS, Node, or zod imports. UI-facing descriptions belong in the describe entry point, not the execution path.
- Keep `@sanoma/workflows/scenario` server-only: the shipped `oxlint.json` refuses it in workflow files, as it does `/fake`. `src/sandbox.ts` is internal; the worker imports it dynamically, only for a sandbox run, so a live worker never loads gherkin or faker. The describe entry loads faker for the operations' mocks through `src/fill.ts`, never gherkin. Keep a sandbox run's seeding in its one checkpointed `sandbox:seed` step.
- Keep `RUNTIME_VERSION` aligned with the package version. Public export changes also affect consumers and the root source aliases.
- `src/datafile.ts` is the one definition of the data-file subset: the reader, `lintResources` and the oxlint plugin all go through it, and `src/paths.ts` decides where an import may reach for both lints and the reader. The rule is configured only in the shipped `oxlint.json`, loaded from `dist/plugin.js`.
- Data files are found from the config's `root` (`defineConfig`'s call site, or set), never the working directory. The JSONL ledger's directory is still relative to the working directory: an inconsistency to fix, not a pattern to copy.

## Checks

Run `pnpm vitest run packages/workflows` with Postgres from `pnpm db:up`, plus `pnpm typecheck` for the type-level tests. Build this package with `pnpm --filter @sanoma/workflows build` before building consumers.
