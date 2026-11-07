# Working on sanoma dev

This part of `sanoma` owns `sanoma dev`, the subcommand a contributor's own Sanoma repo runs to link a sanoma checkout (`link`), undo it (`unlink`) and update to the latest release (`update`). The [README](README.md) is the contract.

- `src/cli.ts` is the subcommand (`dev(argv)`, which the launcher's `src/cli.ts` imports from `sanoma/internal/dev`): the commands and their exit codes (2 for usage, 1 for a failure), pnpm run with its output passed through. `src/links.ts` reads the repo and the checkout: the declared set, where each package is in the checkout, whether a link took, the `link:` lines left behind.
- Never write `package.json`: link only what it declares (`declared`). pnpm owns the `overrides` in `pnpm-workspace.yaml` and the lockfile; this package only reads them.
- Node's modules only; it runs pnpm and imports nothing else of sanoma. The launcher's dev mode decides what to build once the repo is linked.
- The template and a company's docs never mention `sanoma dev`.

Run `pnpm vitest run packages/sanoma/dev`: the commands run against a fake checkout with a `pnpm` on PATH that records its calls; nothing installs or reaches the network.
