# Working on @sanoma-ai/connector-anthropic

Follow the shared [connector conventions](../AGENTS.md). Not built yet: the operator agent's lanes ([#287](https://github.com/Sanoma-AI/sanoma/issues/287)) make it the connector whose `model` gives the agent Anthropic's models. Until then it only pins the AI SDK, and stays `private`, so no release publishes it.

- Pin the AI SDK exactly, at the versions `packages/app` and `packages/workflows` pin (`ai`, `@ai-sdk/provider`): one copy of each in the workspace (`pnpm why ai`), or their `ProviderV4` types stop being assignable across packages. `@ai-sdk/anthropic`, the vendor's SDK, is declared here only.
