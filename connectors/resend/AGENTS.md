# Working on @sanoma/connector-resend

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): operations, credentials, [idempotency](README.md#idempotency), and quota behavior.
- [Source map](src/AGENTS.md): definitions, driver, fake, and generated client.
- [Test map](test/AGENTS.md): broadcast state, errors, and recorded exchanges.

Do not hand-edit `src/generated/`. Change [openapi-ts.config.ts](openapi-ts.config.ts) when needed and regenerate with `pnpm --filter @sanoma/connector-resend generate`. Keep the public `audience` input mapped to Resend's `segment_id`, and preserve the distinction between transient rate limits and exhausted quotas.

Run `pnpm vitest run connectors/resend` for replay tests; they need no vendor account. Credential and recording details belong in the README's [driver testing section](README.md#testing-the-driver).
