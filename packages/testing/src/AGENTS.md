# packages/testing/src

Source of `@sanoma/testing`: the test worker helpers and fake vendors exported from the package root, the msw replay helper exported as `@sanoma/testing/replay`, and the scenario helpers exported as `@sanoma/testing/scenarios`.

## Contents

| Path                           | What it is                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`index.ts`](index.ts)         | `testDatabaseUrl` and `startTestWorker`, plus re-exports of the connector fakes                                                      |
| [`replay.ts`](replay.ts)       | `replay(options)`: serves a vendor's recorded exchanges through msw, and records new ones with `SANOMA_RECORD=1`                     |
| [`scenarios.ts`](scenarios.ts) | `runScenario` runs one scenario as a sandbox run and checks it; `describeScenarios` registers a vitest test per scenario in a config |
