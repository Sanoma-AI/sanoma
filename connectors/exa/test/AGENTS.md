# connectors/exa/test

Tests for the Exa driver. They replay Exa's replies, so they need no account unless run live.

## Contents

| Path                                   | What it is                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | Exa's replies the tests replay, written from its docs until recorded                            |
| [`driver.test.ts`](driver.test.ts)     | `exaDriver`: each operation's request and reply, and Exa's errors, timeouts and dropped replies |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the replies                               |
| [`replay.ts`](replay.ts)               | How Exa's replies are replayed and recorded (`replayOptions`), for both test files              |
