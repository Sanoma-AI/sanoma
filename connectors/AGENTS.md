# connectors

One workspace package per vendor, each built on `@sanoma/workflows`. A connector exposes the vendor's operations and a `./fake` in-memory version for tests. A vendor with an OpenTofu provider (GitHub, Stripe) is one `tfConnector` record from [`@sanoma/bridge/connector`](../packages/bridge/README.md#connectors-for-opentofu-providers) over the types `pnpm generate` writes, which gives its resource types, connector, driver and fake.

## Contents

| Path                            | What it is                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| [`bluesky/`](bluesky/AGENTS.md) | `@sanoma/connector-bluesky`: Bluesky (AT Protocol) post operations and an in-memory fake |
| [`ghost/`](ghost/AGENTS.md)     | `@sanoma/connector-ghost`: Ghost Admin API post operations and an in-memory fake         |
| [`github/`](github/AGENTS.md)   | `@sanoma/connector-github`: GitHub resources read through its OpenTofu provider          |
| [`resend/`](resend/AGENTS.md)   | `@sanoma/connector-resend`: Resend broadcast operations and an in-memory fake            |
| [`stripe/`](stripe/AGENTS.md)   | `@sanoma/connector-stripe`: Stripe resources read through its OpenTofu provider          |

## Shared connector conventions

Keep vendor I/O and credentials in `src/driver.ts`, and simulated behavior in `src/fake.ts`. Handwritten operation schemas live in `src/index.ts`; provider-backed connectors derive operations and resources from their `tfConnector` record and generated types. Follow the package source map. Preserve the separate root, `./driver`, and `./fake` exports so workflow declarations do not import credential-bearing drivers.

Read credentials from the environment when operations are called, not at import, and declare each variable in the driver's `env` (`defineDriver`'s third argument; a provider-backed driver adds it to the driver `tfConnector` returns), named as in the consumer's `.env.example`, with a one-line `.describe()`. Map vendor failures to `DriverError`, preserving retryability and status. Keep fake behavior aligned with the declared operations and the driver's documented idempotency limits.

Driver tests use HTTP replay or a provider state bridge with fixtures by default. Live/recording runs can publish posts or send emails; use them only when the task calls for live vendor work. Before changing fixtures, read [HTTP replay modes](../packages/testing/README.md#replaying-a-vendors-api) for handwritten drivers or [bridge replay](../packages/bridge/README.md#the-fake) for provider-backed drivers. Run `pnpm typecheck` when changing connector schemas or exports, and the affected package's replay tests for driver changes.
