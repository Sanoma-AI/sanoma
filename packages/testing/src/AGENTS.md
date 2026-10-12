# packages/testing/src

Source of `@sanoma/testing`: the test worker helpers exported from the package root, the vitest test app exported as `@sanoma/testing/harness`, the msw replay helper exported as `@sanoma/testing/replay`, and the scenario helpers exported as `@sanoma/testing/scenarios`.

## Contents

| Path                           | What it is                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`index.ts`](index.ts)         | `testDatabaseUrl` and `startTestWorker`, and the `Fake` types from `@sanoma/workflows/fake`                                          |
| [`harness.ts`](harness.ts)     | `useTestApp`: a worker, a `SanomaClient` and a raw `DBOSClient` for a `describe`, with `restart()` on the same ledger                |
| [`replay.ts`](replay.ts)       | `replay(options)`: serves a vendor's recorded exchanges through msw, and records new ones with `SANOMA_RECORD=1`                     |
| [`scenarios.ts`](scenarios.ts) | `runScenario` runs one scenario as a sandbox run and checks it; `describeScenarios` registers a vitest test per scenario in a config |
