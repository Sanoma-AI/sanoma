# Working on @sanoma-ai/connector-supabase

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the project resource, credentials, read/import behavior, and fake usage.
- [Source map](src/AGENTS.md): generated types, hand-owned connector metadata, driver, and fake.
- [Test map](test/AGENTS.md): resource metadata and driver behavior over provider fixtures.

Change `src/resources.config.ts` and `src/connector.ts` for resource definitions; do not hand-edit `src/resources.gen.ts`. Regenerate with `pnpm --filter @sanoma-ai/connector-supabase generate`. Read [bridge generation guidance](../../packages/bridge/src/tfschema/AGENTS.md) when changing type conversion.

Preserve write-only treatment of `database_password`: returned states hold `null` and drift comparisons exclude it. Keep `exists` on the project type: the provider answers a missing project with the state it was given, so `read` imports by ref and a state without a `name` is gone. The Management API operations (`src/management.ts`) never return or log the database URL or the password: only the secrets store holds them. Keep the create guard (a same-name project refuses the create) in front of the provider's create.

Run `pnpm vitest run connectors/supabase` and `pnpm typecheck`; these tests need no vendor credentials. After regeneration, check that a second generation produces no diff.

The server-only `/vault` entry is a `SecretStore`, separate from workflow operations. Its private SQL gateway is in `sql/vault.sql`: keep authorization tied to `session_user`, external mappings read-only, API roles excluded, and conditional writes atomic. Never grant runtime logins direct Vault access. See the README for bootstrap and opt-in actual-extension proof.
