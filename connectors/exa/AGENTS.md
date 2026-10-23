# Working on @sanoma-ai/connector-exa

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): operations, the credential, errors, and what the fake makes up.
- [Source map](src/AGENTS.md): operation schemas, the driver, the generated client, and the fake.
- [Test map](test/AGENTS.md): Exa's replies and driver coverage.

Do not hand-edit `src/generated/`. Change [openapi-ts.config.ts](openapi-ts.config.ts) when needed and regenerate with `pnpm --filter @sanoma-ai/connector-exa generate`. Every operation is a `read`: keep the inputs Exa's own field names and shapes, so the driver sends them as they are.

Run `pnpm vitest run connectors/exa` for replay tests; they need no vendor account. The fixtures were written from Exa's spec and docs, not recorded: record them over when a key is at hand ([driver testing](README.md#testing-the-driver)).
