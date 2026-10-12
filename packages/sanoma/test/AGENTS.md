# packages/sanoma/test

Vitest tests for `sanoma`. `cli.test.ts`, `check.test.ts` and `postgres.test.ts` need Postgres (`pnpm db:up`); `cli.test.ts` and `check.test.ts` run a copy of the fixture repo against the packages' builds, which `fixture.ts` makes when stale.

## Contents

| Path                                     | What it is                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`fixtures/project/`](fixtures/project/) | A company repo: `sanoma.config.ts` on the Ghost fake, `workflows/hello.ts` and `policies/policy.ts` importing from `sanoma`, a scenario, a `tsconfig.json` extending `sanoma/tsconfig.json` |
| [`fixture.ts`](fixture.ts)               | `ensureBuilt`, `copyFixture` (a copy with a `node_modules` of links to this checkout's packages), `startCli`/`runCli`, `waitFor`                                                            |
| [`check.test.ts`](check.test.ts)         | `check` on the fixture, without scenarios: nothing, then tsc's, oxlint's and `describeConfig`'s problems at their positions                                                                 |
| [`cli.test.ts`](cli.test.ts)             | The bin on a fixture copy: `serve` and SIGINT, `env` and `--check`, `check` passing then failing on a bad import and a broken scenario, `--help` and mistakes                               |
| [`dev.test.ts`](dev.test.ts)             | `devRepo` on linked and installed packages, `linkedPackages`, `supervise` restarting a stub child after a write                                                                             |
| [`env.test.ts`](env.test.ts)             | `renderEnvExample` for drivers with required and optional variables, `writeEnvExample` with and without `check`                                                                             |
| [`postgres.test.ts`](postgres.test.ts)   | `ensurePostgres`: answered, a silent remote host, the Docker cases on a stub, and real Docker where installed                                                                               |
