# packages/testing/test

Tests for `@sanoma/testing`. `harness.test.ts` and `scenarios.test.ts` need Postgres (`pnpm db:up`).

## Contents

| Path                                     | What it is                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fakes.test.ts`](fakes.test.ts)         | The connector fakes: idempotent replays, injected faults and file-backed state                                                                                                              |
| [`harness.test.ts`](harness.test.ts)     | `useTestApp`: the resolved config and a restart on the same ledger                                                                                                                          |
| [`scenarios.test.ts`](scenarios.test.ts) | `describeScenarios` on a fixture config, a file that does not load (run in a vitest of its own), and `runScenario`                                                                          |
| [`fixtures/`](fixtures/)                 | A config with the workflows package's announce workflow and the three fakes, a copy of its announce scenarios, a broken feature file, and the vitest config that runs `broken.scenarios.ts` |
