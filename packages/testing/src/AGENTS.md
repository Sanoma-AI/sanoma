# packages/testing/src

Source of `@sanoma/testing`: the test worker helpers and fake vendors exported from the package root, and the msw replay helper exported as `@sanoma/testing/replay`.

## Contents

| Path                     | What it is                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)   | `testDatabaseUrl` and `startTestWorker`, plus re-exports of the connector fakes                                  |
| [`replay.ts`](replay.ts) | `replay(options)`: serves a vendor's recorded exchanges through msw, and records new ones with `SANOMA_RECORD=1` |
