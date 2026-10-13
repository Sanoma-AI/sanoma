# packages/testing/src

Source of `@sanoma/testing`: the test worker helpers exported from the package root, the vitest test app exported as `@sanoma/testing/harness`, the msw replay helper exported as `@sanoma/testing/replay`, the scenario helpers exported as `@sanoma/testing/scenarios`, and a connector's feature tests exported as `@sanoma/testing/features`.

## Contents

| Path                           | What it is                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)         | `testDatabaseUrl`, `withFake` and `startTestWorker` (on a required `databaseUrl`), `ensureBuilt` and `waitFor` (from `build.ts`), and the `Fake` types                                                  |
| [`build.ts`](build.ts)         | `ensureBuilt` (a package's build, when its outputs are stale) and `waitFor` (polling), exported from the root                                                                                           |
| [`features.ts`](features.ts)   | `describeFeatures` registers a vitest test per scenario of a connector's `features/`, on its fake and on its driver (replayed, live or recording), over `testFeature` from `@sanoma/workflows/scenario` |
| [`harness.ts`](harness.ts)     | `useTestApp`: a worker, a `SanomaClient` and a raw `DBOSClient` for a `describe`, with `restart()` on the same ledger                                                                                   |
| [`replay.ts`](replay.ts)       | `replay(options)`: serves a vendor's recorded exchanges through msw, and records new ones with `SANOMA_RECORD=1`                                                                                        |
| [`scenarios.ts`](scenarios.ts) | `describeScenarios` registers a vitest test per scenario in a config, over `runScenario` from `@sanoma/workflows/scenarios`, re-exported                                                                |
