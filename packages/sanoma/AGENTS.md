# Working on sanoma

This package owns the `sanoma` bin a company repo runs, checks and exports itself with, and the author surface (`defineWorkflow`, `definePolicy`, the decisions, `defineConfig`, types) that repo imports. It is the umbrella: it depends on `@sanoma/workflows`, `@sanoma/app` and `@sanoma/bridge` as dependencies, not peers.

## Read when needed

- [README](README.md): the commands, [Postgres in Docker](README.md#postgres), [`.env.example`](README.md#envexample), [the lint](README.md#the-lint) and [dev mode](README.md#dev-mode).
- [Source map](src/AGENTS.md): one module per concern, the bin on top.
- [Test map](test/AGENTS.md): the fixture repo and how the tests wire it.

## Maintenance boundaries

- `src/index.ts` re-exports exactly the names `allowImportNames` in `@sanoma/workflows`'s `oxlint.json` lists, plus `defineConfig` and types. A name added there is added here, and to the `sanoma` entry of that `oxlint.json`, which must list the same names (a test holds it to that).
- The bin never depends on `@sanoma/testing` at run time; it is a devDependency for the fixture and the tests.
- `loadConfig` never calls `defineConfig` on what it loads: the config module's own call recorded its `file`, and a second call from here would record this package's.
- `check` writes its oxlint config into the repo's root for the run (`.oxlintrc.sanoma-check.json`) because oxlint matches the rules' `workflows/**` globs against the config's directory; keep it removed after.
- `tsconfig.base.json` (shipped as `sanoma/tsconfig.json`) is the compiler configuration a company repo extends: keep it the root `tsconfig.json`'s compiler options without the repo's `paths`, and keep `oxlint.json` the root `.oxlintrc.json`'s rules over `@sanoma/workflows`'s.

## Checks

`pnpm vitest run packages/sanoma` needs Postgres (`pnpm db:up`) and builds the packages the fixture loads when they are stale (`packages/workflows`, `connectors/ghost`, `packages/app`, this one). The Docker cases of `postgres.test.ts` run only where `docker` is installed. Run the gate with `SANOMA_TEST_DATABASE_URL` naming a database of your own.
