# Working on @sanoma-ai/connector-neon

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the project resource and the `Database` contract, `storeUrl`, branches and computes, named API-key connections, errors.
- [Source map](src/AGENTS.md): the resource type and its operations, the operations shared by the driver and the fake, the driver, the fake, the steps.
- [Test map](test/AGENTS.md): replies written from Neon's API reference, the features, the Database kit over the fake.

The transport is the raw layer of Neon's official SDK, `@neon/sdk`, pinned exact: one function per endpoint, with none of its ergonomic client's retries or readiness waits, since retrying is the runtime's. Neon's published OpenAPI spec, [`v2.json`](https://neon.com/api_spec/release/v2.json), is the reference for field names and the fixtures. `neonOperations` (`src/operations.ts`) is the one place the operations' logic lives; the driver and the fake differ only in their `NeonApi`. A project's URL carries its role's password: it lives only in the secrets store (`SANOMA_DATABASE_URL_<EXPORT>`) and in `branch.create`'s one reply; never put one in a state, a fixture's state or an error.

Run `pnpm vitest run connectors/neon` with Postgres from `pnpm db:up` (the Database kit runs a worker on the test Postgres); the replay tests need no account.

Later: schema-only and anonymized branches, a project's transfer between organizations, and the kit run live against Neon (H4 of sanoma#350).
