# connectors/resend/test

Tests for the Resend driver. They replay recorded Resend exchanges, and can run against the live API.

## Contents

| Path                                   | What it is                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | Recorded Resend exchanges the tests replay                                                                                |
| [`driver.test.ts`](driver.test.ts)     | `resendDriver`: creating and sending broadcasts, sending an email, `RESEND_FROM`, and quota, rate limit and server errors |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the recorded replies                                                |
| [`replay.ts`](replay.ts)               | How Resend's recorded replies are replayed and recorded (`replayOptions`), for both test files                            |
