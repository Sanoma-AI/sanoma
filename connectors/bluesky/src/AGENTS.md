# connectors/bluesky/src

Source of `@sanoma/connector-bluesky`. Each file is published as its own entry point: the operation definitions, the real driver and the in-memory fake.

## Contents

| Path                           | What it is                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| [`connector.ts`](connector.ts) | Defines the `bluesky` connector: the `bluesky.post.create` operation, its schemas and the logo      |
| [`index.ts`](index.ts)         | The package root: `bluesky` with its driver and fake attached (`withSetup`)                         |
| [`driver.ts`](driver.ts)       | `blueskyDriver`: posts through `@atproto/api` with an app password and maps errors to `DriverError` |
| [`fake.ts`](fake.ts)           | `fakeBluesky`: an in-memory Bluesky for tests                                                       |
