# connectors

One workspace package per vendor, each built on `@sanoma/workflows`. A connector exposes the vendor's operations and a `./fake` in-memory version for tests.

## Contents

| Path                            | What it is                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| [`bluesky/`](bluesky/AGENTS.md) | `@sanoma/connector-bluesky`: Bluesky (AT Protocol) post operations and an in-memory fake |
| [`ghost/`](ghost/AGENTS.md)     | `@sanoma/connector-ghost`: Ghost Admin API post operations and an in-memory fake         |
| [`resend/`](resend/AGENTS.md)   | `@sanoma/connector-resend`: Resend broadcast operations and an in-memory fake            |

## Shared connector conventions

Keep operation schemas in `src/index.ts`, vendor I/O and credentials in `src/driver.ts`, and simulated behavior in `src/fake.ts`. Preserve the separate root, `./driver`, and `./fake` exports so workflow declarations do not import credential-bearing drivers.

Read credentials when operations are called, not at import. Map vendor failures to `DriverError`, preserving retryability and status. Keep fake behavior aligned with the declared operations and the driver's documented idempotency limits.

Driver tests replay scrubbed fixtures by default. Live/recording runs can publish posts or send emails; use them only when the task calls for live vendor work. Read [replay modes](../packages/testing/README.md#replaying-a-vendors-api) before changing fixtures. Run `pnpm typecheck` when changing connector schemas or exports, and the affected package's replay tests for driver changes.
