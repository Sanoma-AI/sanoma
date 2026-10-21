# packages/bridge-bin

One package per platform provider-bridge is released for, `@sanoma-ai/bridge-<platform>`, each an optional dependency of `@sanoma-ai/bridge`, whose `startBridge` runs its `bin/provider-bridge` (see [The binary](../bridge/README.md#the-binary)).

- `bin/` and `licenses/` are absent in the checkout (gitignored). Each package's `prepack` fills them with `../../bridge/scripts/download-bridge.ts --platform <platform>`: the binary of the release `RELEASE` pins, checked against its sha256, and the archive's license texts (provider-bridge's `LICENSE` and `NOTICE`, and the vendored modules'), which ship with it; `postpack` removes them. Packing fails while `RELEASE` is empty.
- `os` and `cpu` sit in `publishConfig`, which pnpm copies into the published manifest: in the manifest itself they would make pnpm warn about the three other platforms on every install and run in the workspace.
- The `bin` field is what makes `pnpm pack` keep the binary executable.
- The version is the shared version of the public packages (`release.yml` checks it); the binary's is `RELEASE.version`. To ship another provider-bridge release, update `RELEASE` from its `SHA256SUMS` and release a new version of the public packages: npm stages a version only once ([Release](../../README.md#release)), so a staged or released version never carries a new binary. A new platform package needs a first publish by hand and its npm trusted publisher before `release.yml` can stage it.
