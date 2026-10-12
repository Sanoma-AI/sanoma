# packages/sanoma/src

The source of `sanoma`: the bin (`cli.ts`, `dist/cli.js` once built) and the modules it is made of, and the package's one entry, `index.ts`.

## Contents

| Path                         | What it is                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cli.ts`](cli.ts)           | The bin: `sanoma`, `serve` (hidden), `worker`, `app`, `check`, `env`, `ledger export`, `--help`; signals, exit codes, dev mode                |
| [`check.ts`](check.ts)       | `check`: tsc, oxlint with the shipped config, `describeConfig`'s problems, `runScenarios`; each problem one line                              |
| [`config.ts`](config.ts)     | `loadConfig`: `.env`, then `sanoma.config.ts`'s default export, with its file and root; `UsageError`                                          |
| [`dev.ts`](dev.ts)           | Dev mode: `devRepo`, `linkedPackages`, `supervise` (restart on a change under `dist/`), `startWatchers` (the checkout's builds in watch mode) |
| [`env.ts`](env.ts)           | `renderEnvExample` and `writeEnvExample`: `.env.example` from the variables the drivers declare                                               |
| [`index.ts`](index.ts)       | The author surface, re-exported from `@sanoma/workflows`: what the lint lets a workflow import, `defineConfig`, types                         |
| [`ledger.ts`](ledger.ts)     | `exportLedger`: a run's records through a `SanomaClient`, as JSON lines                                                                       |
| [`postgres.ts`](postgres.ts) | `ensurePostgres`: probe the URL, else start or create `sanoma-<appName>-postgres` in Docker and wait for it                                   |
| [`serve.ts`](serve.ts)       | `runWorker`, `runApp`, `serve`: the worker (promoted) and the app, stoppable                                                                  |
