# Working on @sanoma-ai/connector-github

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): supported resources, credentials, read/import behavior, and fake usage.
- [Source map](src/AGENTS.md): generated types, hand-owned connector metadata, driver, and fake.
- [Test map](test/AGENTS.md): resource metadata and driver behavior over provider fixtures.

Change `src/resources.config.ts` and `src/connector.ts` for resource definitions; do not hand-edit `src/resources.gen.ts`. Regenerate with `pnpm --filter @sanoma-ai/connector-github generate`. Read [bridge generation guidance](../../packages/bridge/src/tfschema/AGENTS.md) when changing type conversion.

Preserve GitHub identity and find rules, including composite branch-protection identities. The current connector reads and imports resources only; keep operation effects and fake behavior consistent with that contract.

`src/remote.ts` is the remote half (`SourceHost` in `@sanoma-ai/workflows`' `src/source.ts`): plain `fetch`, no Octokit, every token read through `secrets` when called and never logged or recorded (`scrub` in `test/remote.test.ts`). Its tests replay GitHub's answers in `test/fixtures/remote-*.json` and hand-written ones for writes, which skip themselves live so no run opens or merges a pull request.

Run `pnpm vitest run connectors/github` and `pnpm typecheck`; these tests need no vendor credentials. After regeneration, check that a second generation produces no diff.
