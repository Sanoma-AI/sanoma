# connectors/cloudflare/src

Source of the Cloudflare connector: the two resource types, their operations over Cloudflare's API and the company's Worker, the driver, and an in-memory fake that runs the Worker's own code.

## Contents

| Path                           | What it is                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts) | Defines `container` (a host) and `alarm` (a wakeup), their schemas, and `cloudflareOps` with `alarm.register`                                      |
| [`ops.ts`](ops.ts)             | `containerOps` and `alarmOps` over `CloudflareApi`: the upload and its bindings, plans, the wait for a revision, the wake route, refusals          |
| [`driver.ts`](driver.ts)       | `cloudflareDriver`: `CloudflareApi` over the `cloudflare` SDK and `fetch`, failures mapped to `DriverError`, the credentials' `env`                |
| [`registry.ts`](registry.ts)   | `accountImage` and `copyImage`: the declared image copied into the account's registry over the OCI distribution API with `fetch`, pinned by digest |
| [`fake.ts`](fake.ts)           | `fakeCloudflare`: an in-memory account whose Workers serve on this machine and run `worker/instance.js` over an in-process `ctx`                   |
| [`worker.ts`](worker.ts)       | The Worker's modules as uploaded, and `worker/instance.js`'s routes, names and object, re-exported for the package                                 |
| [`steps.ts`](steps.ts)         | `cloudflareSteps`: Cloudflare's steps for Gherkin tests (`defineSteps`)                                                                            |
| [`resources.ts`](resources.ts) | The constructors data files import: `cloudflare.container`, `cloudflare.alarm`                                                                     |
| [`index.ts`](index.ts)         | The package root: `cloudflare` with its driver, fake and steps attached (`withSetup`)                                                              |
