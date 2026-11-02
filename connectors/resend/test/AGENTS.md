# connectors/resend/test

Tests for the Resend driver. They replay recorded Resend exchanges, and can run against the live API.

## Contents

| Path                                   | What it is                                                                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)               | Resend exchanges the tests replay: recorded, except the sending domain's (`features/domain.feature`'s and `domain-restricted-key`), written from Resend's API reference until the first live run re-records them |
| [`driver.test.ts`](driver.test.ts)     | `resendDriver`: creating and sending broadcasts, sending an email, a send with no `from`, quota, rate limit and server errors, and the domain's requests, records, plans, imports and refusals                   |
| [`domain.test.ts`](domain.test.ts)     | `resend.domain` declared, its drift on `status`, and the fake's verification and replace                                                                                                                         |
| [`features.test.ts`](features.test.ts) | `describeFeatures`: `../features/` on the fake and on the recorded replies                                                                                                                                       |
| [`replay.ts`](replay.ts)               | How Resend's recorded replies are replayed and recorded (`replayOptions`), for both test files                                                                                                                   |
