# Working on @sanoma/bridge

This package owns the provider-bridge client, provider replay, and resource schema generation.

- [README](README.md): public API, [connector construction](README.md#connectors-for-opentofu-providers), and [live/recording modes](README.md#the-fake).
- [Source map](src/AGENTS.md): client, configuration, replay, and generation boundaries; follow [tfschema](src/tfschema/AGENTS.md) for schema conversion changes.
- [Test map](test/AGENTS.md): offline coverage versus the opt-in live test.

Keep provider configuration serialized through `ensureConfigured`; preserve reconfiguration after credential changes or provider loss. Recorded fixtures must retain secret scrubbing and rejection of secret-bearing private state.

Do not edit `src/gen/` by hand. Update `proto/` and regenerate with `pnpm --filter @sanoma/bridge run generate`; keep the proto provenance and pinned generator versions aligned as described in [Develop](README.md#develop).

Run `pnpm vitest run packages/bridge connectors/github connectors/stripe` and `pnpm typecheck`. The default tests are offline; live tests require the separate provider-bridge checkout and explicit live mode.
