# connectors/exa/src

Source of the Exa connector: the operation definitions, the driver that calls Exa, and an in-memory fake for tests.

## Contents

| Path                           | What it is                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts) | Defines `exaOps`, the `exa` connector's operations: `web.search`, `web.getContents`, `web.findSimilar` and `web.answer` |
| [`index.ts`](index.ts)         | The package root: `exa` with its driver, fake and steps attached (`withSetup`)                                          |
| [`driver.ts`](driver.ts)       | `exaDriver`: calls Exa through `exa-js`, Exa's SDK, and maps failures to `DriverError`                                  |
| [`fake.ts`](fake.ts)           | `fakeExa`: an in-memory Exa for tests that makes up pages and searches nothing                                          |
| [`steps.ts`](steps.ts)         | `exaSteps`: Exa's steps for Gherkin tests (`defineSteps`)                                                               |
