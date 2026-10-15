# connectors/ghost/src

Source of `@sanoma-ai/connector-ghost`: the operation definitions, the driver that calls the Ghost Admin API, and an in-memory fake for tests.

## Contents

| Path                           | What it is                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts) | Defines `ghostOps`, the `ghost` connector's operations: `post.create` and `post.publish`, their schemas and the logo |
| [`index.ts`](index.ts)         | The package root: `ghost` with its driver, fake and steps attached (`withSetup`), and `Post`                         |
| [`driver.ts`](driver.ts)       | `ghostDriver`: signs Admin API tokens, calls Ghost over HTTP and maps failures to `DriverError`                      |
| [`fake.ts`](fake.ts)           | `fakeGhost`: an in-memory Ghost for tests                                                                            |
| [`steps.ts`](steps.ts)         | `ghostSteps`: Ghost's steps for Gherkin tests (`defineSteps`)                                                        |
