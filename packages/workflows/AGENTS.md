# Working on @sanoma/workflows

This package owns workflow declarations, durable execution, policy and approval enforcement, and the ledger.

## Read when needed

- [README](README.md): public API and examples; [versions](README.md#versions) and [replay safety](README.md#keeping-workflows-replay-safe) for runtime changes.
- [Source map](src/AGENTS.md): locate execution, definitions, analysis, or browser-safe helpers.
- [Test map](test/AGENTS.md): select coverage and the shared DBOS harness.

## Maintenance boundaries

- Keep policy checks, approvals, driver calls, and ledger records coordinated in `src/call.ts`. Changes to the durable call sequence require updating `STEP_LAYOUT` in `src/version.ts` so old runs do not replay against a new layout.
- Keep `src/shared.ts` browser-safe: no DBOS, Node, or zod imports. UI-facing descriptions belong in the describe entry point, not the execution path.
- Keep `RUNTIME_VERSION` aligned with the package version. Public export changes also affect consumers and the root source aliases.

## Checks

Run `pnpm vitest run packages/workflows` with Postgres from `pnpm db:up`, plus `pnpm typecheck` for the type-level tests. Build this package with `pnpm --filter @sanoma/workflows build` before building consumers.
