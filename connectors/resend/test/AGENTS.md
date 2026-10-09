# connectors/resend/test

Tests for the Resend driver. They replay recorded Resend exchanges, and can run against the live API.

## Contents

| Path                               | What it is                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)           | Recorded Resend exchanges the tests replay                                               |
| [`driver.test.ts`](driver.test.ts) | `resendDriver`: creating and sending broadcasts, and quota, rate limit and server errors |
