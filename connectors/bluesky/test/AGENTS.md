# connectors/bluesky/test

Tests for the Bluesky driver. They replay recorded XRPC exchanges, so they need no account unless run live.

## Contents

| Path                               | What it is                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [`fixtures/`](fixtures/)           | Recorded Bluesky exchanges the tests replay, scrubbed of account identifiers |
| [`driver.test.ts`](driver.test.ts) | `blueskyDriver`: posting, idempotent repeats, login and error mapping        |
