# packages/testing/test

Tests for `@sanoma/testing`. `scenarios.test.ts` needs Postgres (`pnpm db:up`).

## Contents

| Path                                     | What it is                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fakes.test.ts`](fakes.test.ts)         | The connector fakes: idempotent replays, injected faults and file-backed state                                                                       |
| [`scenarios.test.ts`](scenarios.test.ts) | `describeScenarios` on a fixture config, a file that does not load (run in a vitest of its own), and `runScenario`                                   |
| [`fixtures/`](fixtures/)                 | The announce workflow and a config with the three fakes, its scenarios, a broken feature file, and the vitest config that runs `broken.scenarios.ts` |
