# connectors

One workspace package per vendor, each built on `@sanoma/workflows`. A connector exposes the vendor's operations and a `./fake` in-memory version for tests.

## Contents

| Path                            | What it is                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| [`bluesky/`](bluesky/AGENTS.md) | `@sanoma/connector-bluesky`: Bluesky (AT Protocol) post operations and an in-memory fake |
| [`ghost/`](ghost/AGENTS.md)     | `@sanoma/connector-ghost`: Ghost Admin API post operations and an in-memory fake         |
| [`github/`](github/AGENTS.md)   | `@sanoma/connector-github`: GitHub resources read through its OpenTofu provider          |
| [`resend/`](resend/AGENTS.md)   | `@sanoma/connector-resend`: Resend broadcast operations and an in-memory fake            |
| [`stripe/`](stripe/AGENTS.md)   | `@sanoma/connector-stripe`: Stripe resources read through its OpenTofu provider          |
