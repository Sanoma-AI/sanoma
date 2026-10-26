# Working on @sanoma-ai/connector-sanoma-ops

Follow the shared [connector conventions](../AGENTS.md).

- [README](README.md): the wakeup resource, `wakeup.register`, the environment, the company's instance token, errors.
- [Source map](src/AGENTS.md): the resource type and `register`, the operations shared by the driver and the fake, the driver, the fake, the steps.
- [Test map](test/AGENTS.md): recorded replies, the conformance kit against the fake and the real service.

The wakeup service is `@sanoma-ai/workflows/wakeup-service` in this repository: its routes are the contract, and a change there is a change here (and a new recording). The instance's token is the company's, minted by `/setup` (`mintInstanceToken`) and posted by `create` and `update`; it lives only in the secrets store (`SANOMA_WAKEUP_TOKEN`): never put it in an output, a state or a fixture. `wakeupOps` (`src/wakeup.ts`) is the one place the operations' logic lives; the driver and the fake differ only in their `WakeupApi`.

Run `pnpm vitest run connectors/sanoma-ops` with Postgres from `pnpm db:up` (the conformance test starts the real service on its own database); the replay tests need no account.
