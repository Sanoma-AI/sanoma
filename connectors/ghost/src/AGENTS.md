# connectors/ghost/src

Source of `@sanoma/connector-ghost`: the operation definitions, the driver that calls the Ghost Admin API, and an in-memory fake for tests.

## Contents

| Path                     | What it is                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| [`index.ts`](index.ts)   | Defines the `ghost` connector: `post.create` and `post.publish`, their schemas and the logo     |
| [`driver.ts`](driver.ts) | `ghostDriver`: signs Admin API tokens, calls Ghost over HTTP and maps failures to `DriverError` |
| [`fake.ts`](fake.ts)     | `fakeGhost`: an in-memory Ghost for tests                                                       |
