# Working on @sanoma-ai/connector-sanoma-cloud

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the database, host and sandbox types, the company (one per token, bound by its id) and its address, the boxes' backend, the driver over sanoma-ops's workflows, the token and the environment, errors, running it live.
- [Source map](src/AGENTS.md): the resource types, the operations shared by the driver and the fake, the boxes' backend, the driver, the fake.
- [Test map](test/AGENTS.md): the driver against a stand-in for the api, the Host, Database and Sandbox kits over the fake.

The vendor id is `cloud` (types `cloud.database`, `cloud.host` and `cloud.sandbox`, as data files import `cloud` from `/resources`); the package is `connector-sanoma-cloud`. The API is sanoma-ops's `cloud-signup`, `cloud-list`, `cloud-deploy` and `cloud-close` (sanoma#514's table), `cloud-available` and `cloud-invite` for going live from a computer (sanoma#717), and `cloud-box-open`, `-expose`, `-stop` and `-discard` for the agent boxes (sanoma#601): keep `src/operations.ts`'s `CloudApi` to their fields. `cloudOperations` is the one place the operations' logic lives, and `cloudBackend` the boxes'; the driver and the fake differ only in their `CloudApi`. The host binds its own bootstrap: never give it a `secrets` field.

Run `pnpm vitest run connectors/sanoma-cloud` with Postgres from `pnpm db:up` (the Host and Database kits run workers on the test Postgres) and the runner built (`workflows/dist/sandbox-runner.cjs`, which the fake's boxes start).

Later: the database's URL through `cloud-list { secrets }` for `storeUrl`, branches, customers' own domains, the `apiKey` named-connection method, and steps and features.
