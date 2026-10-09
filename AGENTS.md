# sanoma

Open core of Sanoma. Business as Code keeps a company's operational configuration (card limits, time-off policies, access, onboarding steps) in typed code and applies it to vendors like Mercury, Gusto and Okta. An agent drafts each change, policies decide who must approve, and a ledger records what happened. This TypeScript monorepo holds the open parts.

Status: early. Business processes are written as TypeScript workflows that run on [DBOS](https://dbos.dev): each vendor call is a durable step, approvals and sleeps survive restarts, and a lint keeps workflow code safe to replay. Versioning is automatic: each run is stamped with a hash of the workflow code it started on, and only a worker on that version resumes it (`DBOS__APPVERSION` names a version instead; see [Versions](packages/workflows/AGENTS.md#versions)).

## Contents

| Path                                                        | What it is                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`packages/`](packages/AGENTS.md)                           | Core workspace packages                                                           |
| [`@sanoma/workflows`](packages/workflows/AGENTS.md)         | Define connectors and workflows, run them durably on DBOS, and lint them          |
| [`@sanoma/app`](packages/app/AGENTS.md)                     | Web UI and JSON API over a config, started with `startApp(config)`                |
| [`@sanoma/testing`](packages/testing/AGENTS.md)             | `startTestWorker`, `testDatabaseUrl` and the connectors' fakes for workflow tests |
| [`connectors/`](connectors/AGENTS.md)                       | Vendor connectors, one workspace package each                                     |
| [`@sanoma/connector-github`](connectors/github/AGENTS.md)   | GitHub resources read through its OpenTofu provider, and a replay fake            |
| [`@sanoma/connector-ghost`](connectors/ghost/AGENTS.md)     | Ghost Admin API post operations and an in-memory fake                             |
| [`@sanoma/connector-resend`](connectors/resend/AGENTS.md)   | Resend broadcast operations and an in-memory fake                                 |
| [`@sanoma/connector-bluesky`](connectors/bluesky/AGENTS.md) | Bluesky post operations and an in-memory fake                                     |
| [`modules/`](modules/AGENTS.md)                             | Placeholder for parts not written yet                                             |
| [`types/`](types/AGENTS.md)                                 | Ambient type declarations shared by the packages                                  |
| [`.github/`](.github/AGENTS.md)                             | GitHub Actions CI                                                                 |
| [`.claude/`](.claude/)                                      | Agent skills for Claude Code                                                      |
| [`.agents/`](.agents/)                                      | Vendored agent skills                                                             |
| [`package.json`](package.json)                              | Root scripts: typecheck, build, lint, format, test, `db:up`                       |
| [`tsconfig.json`](tsconfig.json)                            | Root TypeScript config with `@sanoma/*` paths to each package's `src/`            |
| [`vitest.config.ts`](vitest.config.ts)                      | Test config with aliases to the package sources                                   |
| [`docker-compose.yml`](docker-compose.yml)                  | Postgres for DBOS on port 5433                                                    |
| [`lefthook.yml`](lefthook.yml)                              | Pre-commit format and lint on staged files                                        |
| [`.oxlintrc.json`](.oxlintrc.json)                          | Lint config                                                                       |
| [`.oxfmtrc.json`](.oxfmtrc.json)                            | Format config                                                                     |
| [`pnpm-workspace.yaml`](pnpm-workspace.yaml)                | Workspace globs: `packages/*` and `connectors/*`                                  |
| [`.pnpmfile.cjs`](.pnpmfile.cjs)                            | pnpm hook: a packed package's readme is its AGENTS.md without the Contents table  |
| [`skills-lock.json`](skills-lock.json)                      | Lock file for installed agent skills                                              |

Community connectors live in their authors' own repos (`sanoma-connector-<vendor>`) and are listed in [`Sanoma-AI/registry`](https://github.com/Sanoma-AI/registry).

## Develop

Needs Node 24 or later, pnpm, and Docker for the workflow tests.

```sh
pnpm install
pnpm db:up          # Postgres for DBOS on port 5433
pnpm test           # vitest, runs against the TypeScript sources
pnpm typecheck
pnpm lint && pnpm format:check
pnpm build          # compiles each package to dist/ for publishing
```

Inside the repo, `@sanoma/*` imports resolve to each package's `src/` (via `paths` in `tsconfig.json` and aliases in `vitest.config.ts`), so tests and typechecks need no build. Published packages ship the compiled `dist/`, not the sources.

## License

[Apache License 2.0](LICENSE).

## Contributing

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). Sign off every commit with `git commit -s`. See the org-wide contributing guide, code of conduct and security policy in [`Sanoma-AI/.github`](https://github.com/Sanoma-AI/.github).
