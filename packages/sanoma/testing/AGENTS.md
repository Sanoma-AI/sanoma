# Working on sanoma/testing

This part of `sanoma` (`sanoma/testing` and its subpaths) owns test-worker setup, the vitest test app, recorded HTTP replay, scenario tests and connectors' feature tests. Vendor fakes live in their connector packages, at `@sanoma-ai/connector-<vendor>/fake`.

## Read when needed

- [README](README.md): helper usage, [database isolation](README.md#a-worker-for-a-test), [the test app](README.md#a-test-app) (`sanoma/testing/harness`), and [replay/recording modes](README.md#replaying-a-vendors-api).
- [Scenarios](README.md#scenarios): `describeScenarios` and `runScenario`, a config's scenarios as vitest tests.
- [A connector's own features](README.md#a-connectors-own-features): `describeFeatures`, a connector's feature files on its fake and on its driver.
- [A host's conformance](README.md#a-hosts-conformance), [a wakeup's](README.md#a-wakeups-conformance), [a database's](README.md#a-databases-conformance) and [a sandbox's](README.md#a-sandboxs-conformance): `checkHost`, `fakeHost` (long-lived or one that stops), `checkWakeup`, `fakeWakeup`, `checkDatabase`, `fakeDatabase`, `checkSandbox` and `fakeSandbox`.
- [Source map](src/AGENTS.md): worker helpers at the root versus the `./harness`, `./replay`, `./scenarios`, `./host`, `./wakeup`, `./database` and `./sandbox` entry points.
- [Test map](test/AGENTS.md): fake behavior coverage; connector driver tests exercise replay.

## Maintenance boundaries

- Preserve `startTestWorker`'s database isolation: it runs on the required `options.databaseUrl`, never the config's. Tests are kept apart by database (`testDatabaseUrl(name)` per file or per `describe` that starts a worker), not by app name: the app keeps its root's name.
- It imports `sanoma/workflows`, and `pg` for `fakeDatabase`'s SQL and `findSentinels`' reads only; connectors are the workspace root's devDependencies, for its tests, never imported from `src/`.
- Keep msw and vitest dependencies confined to `./harness`, `./replay`, `./scenarios` and `./features`, since they are optional peers of `sanoma`. Do not pull them into `sanoma/testing` itself, nor any part's module a company loads.
- Replay must fail on unexpected requests and unconsumed exchanges. Recording must scrub credentials and identifying data before fixtures are committed.

## Checks

Run `pnpm vitest run packages/sanoma/testing connectors` for replay changes, plus `pnpm typecheck`. Test worker changes also need the workflow tests and Postgres.
