# Working on @sanoma-ai/connector-anthropic

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the models, the key and what a missing key does.

## Contents

| Path                                               | What it is                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`src/connector.ts`](src/connector.ts)             | `anthropicOps`: no operations                                                                |
| [`src/driver.ts`](src/driver.ts)                   | `anthropicDriver`: no operations, `env` declaring `ANTHROPIC_API_KEY` for the connector page |
| [`src/model.ts`](src/model.ts)                     | `anthropicModel`, the model half, and `ANTHROPIC_DEFAULT_MODEL`                              |
| [`src/index.ts`](src/index.ts)                     | The package root: `anthropic` (`withSetup({ driver, model })`)                               |
| [`test/model.test.ts`](test/model.test.ts)         | The model half over a stubbed `fetch`: the key per request, the default, a missing key       |
| [`test/connector.test.ts`](test/connector.test.ts) | The connector as the app and the runtime read it                                             |

## Boundaries

- The model half is `@ai-sdk/anthropic`'s provider, the vendor's adapter as the transport, wrapped in `customProvider` only for the `default` alias. Its `fetch` reads the key through `ModelContext.secrets` at each request and sets `x-api-key`; never read the key at import or when the provider is made, so a key set on the connector page is used without a restart.
- Pin the AI SDK exactly, at the versions `packages/app` and `packages/workflows` pin (`ai`, `@ai-sdk/provider`): one copy of each in the workspace (`pnpm why ai`), or their `ProviderV4` types stop being assignable across packages. `@ai-sdk/anthropic`, the vendor's SDK, is declared here only.
- Tests never call Anthropic: the model half runs over a stubbed `fetch`, the registry over `MockLanguageModelV4` (`packages/app/test/models.test.ts`).

Run `pnpm vitest run connectors/anthropic`; it needs no key and no database.
