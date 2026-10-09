# connectors/bluesky/src

Source of `@sanoma/connector-bluesky`. Each file is published as its own entry point: the operation definitions, the real driver and the in-memory fake.

## Contents

| Path                     | What it is                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)   | Defines the `bluesky` connector: the `bluesky.post.create` operation, its schemas and the logo      |
| [`driver.ts`](driver.ts) | `blueskyDriver`: posts through `@atproto/api` with an app password and maps errors to `DriverError` |
| [`fake.ts`](fake.ts)     | `fakeBluesky`: an in-memory Bluesky for tests                                                       |
