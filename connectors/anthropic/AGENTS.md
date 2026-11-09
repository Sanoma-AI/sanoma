# Working on @sanoma-ai/connector-anthropic

Follow the shared [connector conventions](../AGENTS.md). The [README](README.md) has the models, the key and what a missing key does.

## Contents

| Path                                               | What it is                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`src/connector.ts`](src/connector.ts)             | `anthropicOps`: no operations                                                                       |
| [`src/driver.ts`](src/driver.ts)                   | `anthropicDriver`: no operations, `env` declaring `ANTHROPIC_API_KEY` for the connector page        |
| [`src/model.ts`](src/model.ts)                     | `anthropicModel`, the model half, and `ANTHROPIC_DEFAULT_MODEL`                                     |
| [`src/agent.ts`](src/agent.ts)                     | `claudeCode`, Claude Code's agent part: its ACP install for a person's plan, its adapter on the key |
| [`src/index.ts`](src/index.ts)                     | The package root: `anthropic` (`withSetup({ driver, model, agent })`)                               |
| [`test/model.test.ts`](test/model.test.ts)         | The model half over a stubbed `fetch`: the key per request, the default, a missing key              |
| [`test/connector.test.ts`](test/connector.test.ts) | The connector as the app and the runtime read it, Claude Code's agent and its adapter loaded        |

## Boundaries

- The model half is `@ai-sdk/anthropic`'s provider, the vendor's adapter as the transport, wrapped in `customProvider` only for the `default` alias. Its `fetch` reads the key through `ModelContext.secrets` at each request and sets `x-api-key`; never read the key at import or when the provider is made, so a key set on the connector page is used without a restart.
- Pin the AI SDK exactly, at the versions `packages/sanoma/app` and `packages/sanoma/workflows` pin (`ai`, `@ai-sdk/provider`): one copy of each in the workspace (`pnpm why ai`), or their `ProviderV4` types stop being assignable across packages. `@ai-sdk/anthropic`, the vendor's SDK, is declared here only.
- Claude Code's adapter (`@ai-sdk/harness-claude-code`) is pinned exactly at the version whose `@ai-sdk/harness` the app pins, and imported only in `harness`, by a name the bundler leaves alone (`/* @vite-ignore */`): a Worker that carries this connector never bundles it, and the adapter runs its bridge from files beside its own `dist/`. Who the agent is (`claude-code`, its title and `claude-code.svg`) is `package.json`'s `sanoma.agent`; the mark's license is `MARKS-LICENSE`.
- Tests never call Anthropic: the model half runs over a stubbed `fetch`, the registry over `MockLanguageModelV4` (`packages/sanoma/app/test/models.test.ts`).

Run `pnpm vitest run connectors/anthropic`; it needs no key and no database.
