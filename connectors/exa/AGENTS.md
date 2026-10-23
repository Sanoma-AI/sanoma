# Working on @sanoma-ai/connector-exa

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): operations, the credential, errors, and what the fake makes up.
- [Source map](src/AGENTS.md): operation schemas, the driver over `exa-js`, and the fake.
- [Test map](test/AGENTS.md): Exa's replies and driver coverage.

The driver calls Exa through `exa-js`, Exa's SDK, loaded at the first call, never at import: the replay tests need `fetch` patched before the SDK takes it. Every operation is a `read`: keep the inputs a cut of the SDK's options, in its field names and shapes, so the driver passes them as they are.

Run `pnpm vitest run connectors/exa` for replay tests; they need no vendor account. The fixtures were written from Exa's docs, not recorded: record them over when a key is at hand ([driver testing](README.md#testing-the-driver)).
