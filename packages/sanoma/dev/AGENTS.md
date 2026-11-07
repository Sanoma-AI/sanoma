# Working on @sanoma-ai/dev

This package owns `sanoma-dev`, the bin a contributor's own Sanoma repo runs to link a sanoma checkout (`link`), undo it (`unlink`) and update to the latest release (`update`). The [README](README.md) is the contract.

- `src/cli.ts` is the bin: the commands and their exit codes (2 for usage, 1 for a failure), pnpm run with its output passed through. `src/links.ts` reads the repo and the checkout: the declared set, where each package is in the checkout, whether a link took, the `link:` lines left behind.
- Never write `package.json`: link only what it declares (`declared`). pnpm owns the `overrides` in `pnpm-workspace.yaml` and the lockfile; this package only reads them.
- Node's modules only, no dependencies; it runs pnpm and never imports sanoma. The launcher's dev mode decides what to build once the repo is linked.
- The template and a company's docs never mention this package.

Run `pnpm vitest run packages/dev`: the commands run against a fake checkout with a `pnpm` on PATH that records its calls; nothing installs or reaches the network.
