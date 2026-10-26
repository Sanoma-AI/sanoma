# connectors/sanoma-ops/test

Tests for the wakeup connector: recorded replies of a local `sanoma wakeup`, and the Wakeup contract's conformance kit.

## Contents

| Path                                   | What it is                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | The service's recorded exchanges, one per feature scenario, ids and tokens scrubbed                                                |
| [`driver.test.ts`](driver.test.ts)     | `sanomaOpsDriver`: tokens, the instance token posted (minted when none is), a new host as a move, gone instances and error mapping |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the recorded replies                                                         |
| [`wakeup.test.ts`](wakeup.test.ts)     | `checkWakeup` against the fake and the real service (needs Postgres), and the wakeup declared in a data file                       |
| [`replay.ts`](replay.ts)               | How the recorded replies are replayed and recorded (`replayOptions`, `scrub`), for both replay test files                          |
| [`service.ts`](service.ts)             | `serveWakeup`: the real service in the test's process on a free port, for the conformance test and recording                       |
