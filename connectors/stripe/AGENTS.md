# Working on @sanoma/connector-stripe

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): supported resources, credentials, read/import behavior, and fake usage.
- [Source map](src/AGENTS.md): generated types, hand-owned connector metadata, driver, and fake.
- [Test map](test/AGENTS.md): resource metadata and driver behavior over provider fixtures.

Change `src/resources.config.ts` and `src/connector.ts` for resource definitions; do not hand-edit `src/resources.gen.ts`. Regenerate with `pnpm --filter @sanoma/connector-stripe generate`. Read [bridge generation guidance](../../packages/bridge/src/tfschema/AGENTS.md) when changing type conversion.

Preserve write-only treatment of webhook secrets: returned states redact them and drift comparisons exclude them. The current connector reads and imports resources only; keep operation effects and fake behavior consistent with that contract.

Run `pnpm vitest run connectors/stripe` and `pnpm typecheck`; these tests need no vendor credentials. After regeneration, check that a second generation produces no diff.
