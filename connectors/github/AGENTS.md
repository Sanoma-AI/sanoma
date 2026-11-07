# Working on @sanoma-ai/connector-github

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): supported resources, credentials, read/import behavior, and fake usage.
- [Source map](src/AGENTS.md): generated types, hand-owned connector metadata, driver, and fake.
- [Test map](test/AGENTS.md): resource metadata and driver behavior over provider fixtures.

Change `src/resources.config.ts` and `src/connector.ts` for resource definitions; do not hand-edit `src/resources.gen.ts`. Regenerate with `pnpm --filter @sanoma-ai/connector-github generate`. Read [bridge generation guidance](../../packages/sanoma/bridge/src/tfschema/AGENTS.md) when changing type conversion.

Preserve GitHub identity and find rules, including composite branch-protection identities. The owner of a repository is a field of the resource (`owner`, required on a repository and a team membership) and the `<owner>/` of every name, never an environment variable or a default from the token's user; `src/owner.ts` configures the provider for the owner each call names and refuses a call that names none. The resource types are read and imported (a repository, a deploy key and a collaborator are changed only by apply); keep operation effects and fake behavior consistent with that contract.

The operations through the App (`installation.get`, `repository.generate`, `.commit`, `.head`, `.addDeployKey`) are hand-written specs in `src/connector.ts` (`githubApp`, merged into `githubOps` in the repository's group), implemented by `appDriver` in `src/driver.ts` and `fakeGithubApp` in `src/fake.ts`. They sign with the App's keys from `CallContext.secrets` and mint an installation token per call: never keep, log or return it. Their tests replay hand-written replies in `test/fixtures/app-*.json` and skip themselves live.

`src/remote.ts` is the remote half (`SourceHost` in `sanoma/workflows`' `src/source.ts`): plain `fetch` through `src/rest.ts` (shared with the operations through the App), no Octokit, every token read through `secrets` when called and never logged or recorded (`scrub` in `test/remote.test.ts`). Its tests replay GitHub's answers in `test/fixtures/remote-*.json` and hand-written ones for writes, which skip themselves live so no run opens or merges a pull request.

Run `pnpm vitest run connectors/github` and `pnpm typecheck`; these tests need no vendor credentials. After regeneration, check that a second generation produces no diff.
