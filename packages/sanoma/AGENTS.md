# Working on sanoma

This package owns the `sanoma` bin a company repo runs, checks and exports itself with, and everything that repo imports besides its connectors (the author surface, `z`, `defineConfig`, the ledger stores, types): the one install. It is the umbrella: it depends on `@sanoma/workflows`, `@sanoma/app` and `@sanoma/bridge` as dependencies, not peers.

## Read when needed

- [README](README.md): the commands, [Postgres in Docker](README.md#postgres), [`.env.example`](README.md#envexample), [the lint](README.md#the-lint) and [dev mode](README.md#dev-mode).
- [Source map](src/AGENTS.md): one module per concern, the bin on top.
- [Test map](test/AGENTS.md): the fixture repo and how the tests wire it.

## Maintenance boundaries

- `src/index.ts` re-exports exactly the names `allowImportNames` in `@sanoma/workflows`'s `oxlint.json` lists (`z` from `zod`, the rest from `@sanoma/workflows`), plus what `sanoma.config.ts` needs (`defineConfig`, the ledger stores) and types. A name added there is added here.
- What a company repo's code imports at run time or for `tsc` is a dependency here, not a peer or a devDependency (`zod`, `@types/node`, `typescript`, `oxlint`): the repo installs `sanoma` and its connectors alone. The fixture holds that promise, with only those two linked.
- The bin never depends on `@sanoma/testing` at run time; it is a devDependency for the fixture and the tests.
- `loadConfig` never calls `defineConfig` on what it loads: the config module's own call recorded its `file`, and a second call from here would record this package's.
- `check` writes its oxlint config into the repo's root for the run (`.oxlintrc.sanoma-check.json`) because oxlint matches the rules' `workflows/**` globs against the config's directory; keep it removed after.
- `tsconfig.base.json` (shipped as `sanoma/tsconfig.json`) is the compiler configuration a company repo extends, and the root `tsconfig.json` extends it too, adding the checkout's `paths`, `typeRoots`, `include` and `exclude`: there is one copy of the compiler options. Keep `oxlint.json` the root `.oxlintrc.json`'s rules over `@sanoma/workflows`'s.

## Checks

`pnpm vitest run packages/sanoma` needs Postgres (`pnpm db:up`) and builds the packages the fixture loads when they are stale (`packages/workflows`, `connectors/ghost`, `packages/app`, this one). The Docker cases of `postgres.test.ts` run only where `docker` is installed. Run the gate with `SANOMA_TEST_DATABASE_URL` naming a database of your own.
