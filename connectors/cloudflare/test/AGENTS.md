# connectors/cloudflare/test

Tests for the Cloudflare connector: the Worker's code, the driver over replies written from Cloudflare's API reference, the features, and the Host and Wakeup kits on the fake.

## Contents

| Path                                   | What it is                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | Cloudflare's replies, written from its API reference (not recorded), one file per feature scenario plus `update-to-a-new-image` |
| [`driver.test.ts`](driver.test.ts)     | `cloudflareDriver`: the upload's form, rollouts, reads, deletes, refusals, error mapping, timeouts, credentials, the wake route |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the fixtures                                                              |
| [`host.test.ts`](host.test.ts)         | The Host kit (`checkHost`) against `cloudflare.container` on the fake, the company's runtime in this process; needs Postgres    |
| [`wakeup.test.ts`](wakeup.test.ts)     | The Wakeup kit (`checkWakeup`) against `cloudflare.alarm` on the fake, and the alarm declared in a data file; needs Postgres    |
| [`registry.test.ts`](registry.test.ts) | `copyImage` against two small registries in this process: blobs streamed, one already there, the skip, a missing tag            |
| [`worker.test.ts`](worker.test.ts)     | `worker/instance.js` and `index.js` over a stubbed `ctx`: the wake route, starts, deploys, the proxy and the alarm              |
| [`replay.ts`](replay.ts)               | How the replies are replayed and recorded (`replayOptions`), for the driver tests and the features                              |
| [`live.ts`](live.ts)                   | Both kits against a real account and the cold wake's time, run by hand (README, "Running it live"); not a test file             |
