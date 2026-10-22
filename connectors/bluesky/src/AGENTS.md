# connectors/bluesky/src

Source of `@sanoma-ai/connector-bluesky`. Each file is published as its own entry point: the operation definitions, the real driver and the in-memory fake.

## Contents

| Path                           | What it is                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [`connector.ts`](connector.ts) | Defines `blueskyOps`, the `bluesky` connector's operations: the `bluesky.post.create` operation, its schemas |
| [`index.ts`](index.ts)         | The package root: `bluesky` with its driver, fake and steps attached (`withSetup`)                           |
| [`driver.ts`](driver.ts)       | `blueskyDriver`: posts through `@atproto/api` with an app password and maps errors to `DriverError`          |
| [`fake.ts`](fake.ts)           | `fakeBluesky`: an in-memory Bluesky for tests                                                                |
| [`steps.ts`](steps.ts)         | `blueskySteps`: Bluesky's steps for Gherkin tests (`defineSteps`)                                            |
