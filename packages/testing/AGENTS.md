# Working on @sanoma/testing

This package owns test-worker setup, recorded HTTP replay and scenario tests. Vendor fakes live in their connector packages, at `@sanoma/connector-<vendor>/fake`.

## Read when needed

- [README](README.md): helper usage, [database isolation](README.md#a-worker-for-a-test), and [replay/recording modes](README.md#replaying-a-vendors-api).
- [Scenarios](README.md#scenarios): `describeScenarios` and `runScenario`, a config's scenarios as vitest tests.
- [Source map](src/AGENTS.md): worker helpers versus the separate replay entry point.
- [Test map](test/AGENTS.md): fake behavior coverage; connector driver tests exercise replay.

## Maintenance boundaries

- Preserve `startTestWorker`'s database isolation: ignore the config's database URL unless explicitly overridden through test options. Use a unique app name per test file.
- This package depends on `@sanoma/workflows` only; connectors are devDependencies for its tests, never imported from `src/`.
- Keep msw and vitest dependencies confined to `./replay` and `./scenarios`, since they are optional peers. Do not pull them into the package root.
- Replay must fail on unexpected requests and unconsumed exchanges. Recording must scrub credentials and identifying data before fixtures are committed.

## Checks

Run `pnpm vitest run packages/testing connectors` for replay changes, plus `pnpm typecheck`. Test worker changes also need the workflow tests and Postgres.
