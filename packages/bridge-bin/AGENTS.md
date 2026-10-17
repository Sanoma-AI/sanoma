# packages/bridge-bin

One package per platform provider-bridge is released for, `@sanoma-ai/bridge-<platform>`, each an optional dependency of `@sanoma-ai/bridge`, whose `startBridge` runs its `bin/provider-bridge` (see [The binary](../bridge/README.md#the-binary)).

- `bin/` is empty in the checkout (gitignored). Each package's `prepack` fills it with `../../bridge/scripts/download-bridge.ts --platform <platform>`: the release `RELEASE` pins, checked against its sha256. Packing fails while `RELEASE` is empty.
- `os` and `cpu` sit in `publishConfig`, which pnpm copies into the published manifest: in the manifest itself they would make pnpm warn about the three other platforms on every install and run in the workspace.
- The `bin` field is what makes `pnpm pack` keep the binary executable.
- The version is the shared version of the public packages (`release.yml` checks it); the binary's is `RELEASE.version`. To ship another provider-bridge release, update `RELEASE` from its `SHA256SUMS`.
