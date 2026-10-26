# connectors/neon/test

Tests for the Neon connector: replies written from Neon's API reference, the features, and the Database contract's conformance kit.

## Contents

| Path                                   | What it is                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | Neon's exchanges, written by hand from the SDK's bundled OpenAPI spec (no key recorded them): the driver tests' and one per feature scenario |
| [`driver.test.ts`](driver.test.ts)     | `neonDriver`: the requests it sends, plans, the replace refused, health, the URL stored and refused, branches, computes, error mapping       |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the replies                                                                            |
| [`database.test.ts`](database.test.ts) | `checkDatabase` over the fake with the test Postgres as its database (needs Postgres), the type in a config, and the project in a data file  |
| [`replay.ts`](replay.ts)               | How the replies are replayed and recorded (`replayOptions`, `scrub`), for both replay test files                                             |
