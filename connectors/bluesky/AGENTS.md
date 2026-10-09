# Working on @sanoma/connector-bluesky

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): operations, credentials, [idempotency](README.md#idempotency), and vendor limitations.
- [Source map](src/AGENTS.md): operation schemas, the AT Protocol driver, and the fake.
- [Test map](test/AGENTS.md): recorded XRPC exchanges and driver coverage.

Preserve deterministic record keys derived from the call's idempotency key. Recovery must distinguish an existing matching post from a conflicting record or an inconclusive lookup. Keep the driver's cached session scoped to its service and account.

Run `pnpm vitest run connectors/bluesky` for replay tests; they need no vendor account. Credential and recording details belong in the README's [driver testing section](README.md#testing-the-driver).
