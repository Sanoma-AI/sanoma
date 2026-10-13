# Working on @sanoma/testing

This private package (the monorepo's tests only; not published) owns test-worker setup, the vitest test app, recorded HTTP replay, scenario tests and connectors' feature tests. Vendor fakes live in their connector packages, at `@sanoma/connector-<vendor>/fake`.

## Read when needed

- [README](README.md): helper usage, [database isolation](README.md#a-worker-for-a-test), [the test app](README.md#a-test-app) (`@sanoma/testing/harness`), and [replay/recording modes](README.md#replaying-a-vendors-api).
- [Scenarios](README.md#scenarios): `describeScenarios` and `runScenario`, a config's scenarios as vitest tests.
- [A connector's own features](README.md#a-connectors-own-features): `describeFeatures`, a connector's feature files on its fake and on its driver.
- [Source map](src/AGENTS.md): worker helpers at the root versus the `./harness`, `./replay` and `./scenarios` entry points.
- [Test map](test/AGENTS.md): fake behavior coverage; connector driver tests exercise replay.

## Maintenance boundaries

- Preserve `startTestWorker`'s database isolation: it runs on the required `options.databaseUrl`, never the config's. Tests are kept apart by database (`testDatabaseUrl(name)` per file or per `describe` that starts a worker), not by app name: the app keeps its root's name.
- This package depends on `@sanoma/workflows` only; connectors are devDependencies for its tests, never imported from `src/`.
- Keep msw and vitest dependencies confined to `./harness`, `./replay`, `./scenarios` and `./features`, since they are optional peers. Do not pull them into the package root. `@dbos-inc/dbos-sdk` is a peer for `./harness`'s `raw` client, and so for `./scenarios`, which runs on `./harness`.
- Replay must fail on unexpected requests and unconsumed exchanges. Recording must scrub credentials and identifying data before fixtures are committed.

## Checks

Run `pnpm vitest run packages/testing connectors` for replay changes, plus `pnpm typecheck`. Test worker changes also need the workflow tests and Postgres.
