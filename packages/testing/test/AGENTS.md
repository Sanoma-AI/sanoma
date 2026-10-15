# packages/testing/test

Tests for `@sanoma-ai/testing`. `harness.test.ts` and `scenarios.test.ts` need Postgres (`pnpm db:up`).

## Contents

| Path                                     | What it is                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fakes.test.ts`](fakes.test.ts)         | The connector fakes: idempotent replays, injected faults, `update` and a shared call log                                                                                                                                                                        |
| [`harness.test.ts`](harness.test.ts)     | `useTestApp`: one config, so the client reads both runs across a restart                                                                                                                                                                                        |
| [`scenarios.test.ts`](scenarios.test.ts) | `describeScenarios` on a fixture config, a file that does not load (run in a vitest of its own), and `runScenario`                                                                                                                                              |
| [`fixtures/`](fixtures/)                 | A root with a config of the workflows package's announce workflow on the packages' connectors, a copy of its announce scenarios in `scenarios/`, a root with a broken feature file (`broken/scenarios/`), and the vitest config that runs `broken.scenarios.ts` |
