# connectors/sanoma-ops/src

Source of `@sanoma-ai/connector-sanoma-ops`: the wakeup resource type, its register operation, the driver over the wakeup service and an in-memory fake.

## Contents

| Path                           | What it is                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts) | `wakeup` (the resource type, which meets the `Wakeup` contract) and `sanomaOpsOps`, its operations with `wakeup.register` merged in |
| [`wakeup.ts`](wakeup.ts)       | `wakeupOps`: the operations over a `WakeupApi` (plan, the stored token, the refusals), shared by the driver and the fake            |
| [`driver.ts`](driver.ts)       | `sanomaOpsDriver`: the `WakeupApi` over the service's routes with `fetch`, its `env`, and `HOSTED_URL`                              |
| [`fake.ts`](fake.ts)           | `fakeSanomaOps`: an in-memory service that sends the host's `/wake` at `at`, with `fire()` and `close()`                            |
| [`resources.ts`](resources.ts) | The `./resources` entry: `sanomaOps.wakeup`, the constructor a data file declares the wakeup with                                   |
| [`steps.ts`](steps.ts)         | `sanomaOpsSteps`: the connector's steps for Gherkin tests (`defineSteps`)                                                           |
| [`index.ts`](index.ts)         | The package root: `sanomaOps` with its driver, fake and steps attached (`withSetup`)                                                |
