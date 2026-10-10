# Working on @sanoma/workflows

This package owns workflow declarations, durable execution, policy and approval enforcement, and the ledger.

## Read when needed

- [README](README.md): public API, [resources](README.md#resources), and examples; [versions](README.md#versions) and [replay safety](README.md#keeping-workflows-replay-safe) for runtime changes.
- [Source map](src/AGENTS.md): locate execution, definitions, analysis, or browser-safe helpers.
- [Test map](test/AGENTS.md): select coverage and the shared DBOS harness.

## Maintenance boundaries

- Keep policy checks, approvals, driver calls, and ledger records coordinated in `src/call.ts`. Changes to the durable call sequence require updating `STEP_LAYOUT` in `src/version.ts` so old runs do not replay against a new layout.
- Keep `src/shared.ts` browser-safe: no DBOS, Node, or zod imports. UI-facing descriptions belong in the describe entry point, not the execution path.
- The outline (`src/outline.ts`) is a contract, not a reading, and the one definition of what a workflow may write: `outlineBody` returns the nodes and the `problems` (what the graph cannot draw), `startWorker` and `lintWorkflow` both refuse on the problems, and the worker places every `ctx` call in the nodes at run time (`src/call.ts` `placeCall`, the backstop for what no static reading sees, such as `arguments`). A new rule goes in `outlineBody`, with a test in `outline.test.ts` or `lint.test.ts` and, when the worker's refusal is what matters, `callsite.test.ts`.
- Keep `RUNTIME_VERSION` aligned with the package version. Public export changes also affect consumers and the root source aliases.
- `src/datafile.ts` is the one definition of the data-file subset: the reader, `lintResources` and the oxlint plugin all go through it, and `src/paths.ts` decides where an import may reach for both lints and the reader. The rule is configured only in the shipped `oxlint.json`, loaded from `dist/plugin.js`.
- `src/drift.ts` is held to the workflow lint (a test lints it), so it imports no DBOS and makes no dynamic import: its data-file step is made in `src/config.ts` and passed in. The worker takes every definition, the built-in's too, from the running worker's config by name.
- Data files are found from the config's `root` (`defineConfig`'s call site, or set), never the working directory. The JSONL ledger's directory is still relative to the working directory: an inconsistency to fix, not a pattern to copy.

## Checks

Run `pnpm vitest run packages/workflows` with Postgres from `pnpm db:up`, plus `pnpm typecheck` for the type-level tests. Build this package with `pnpm --filter @sanoma/workflows build` before building consumers.
