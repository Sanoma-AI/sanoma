# Working on @sanoma/connector-ghost

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): operations, credentials, [idempotency](README.md#idempotency), and vendor limitations.
- [Source map](src/AGENTS.md): operation schemas, Admin API driver, and fake.
- [Test map](test/AGENTS.md): recorded replies, publish retries, and update collisions.

Preserve the distinction between creating a draft and publishing it. Publishing reads current state and handles Ghost's update-collision behavior; do not turn non-idempotent creation into an automatically retried operation without vendor guarantees.

Run `pnpm vitest run connectors/ghost` for replay tests; they need no vendor account. Credential and recording details belong in the README's [driver testing section](README.md#testing-the-driver).
