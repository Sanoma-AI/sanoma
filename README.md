# sanoma

Open core of Sanoma. Business as Code keeps a company's operational configuration (card limits, time-off policies, access, onboarding steps) in typed code and applies it to vendors like Mercury, Gusto and Okta. An agent drafts each change, policies decide who must approve, and a ledger records what happened. This TypeScript monorepo holds the open parts.

Status: early. Business processes are written as TypeScript workflows that run on [DBOS](https://dbos.dev): each vendor call is a durable step, approvals and sleeps survive restarts, and a lint keeps workflow code safe to replay. Versioning is automatic: each run is stamped with a hash of the workflow code it started on, and only a worker on that version resumes it (`DBOS__APPVERSION` names a version instead; see [Versions](packages/workflows/README.md#versions)).

## Packages

| Package                                           | What it is                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`@sanoma/workflows`](packages/workflows)         | Define connectors and workflows, run them durably, lint them (`./lint`, `oxlint.json`); `./fake` builds a fake for any connector |
| [`@sanoma/app`](packages/app)                     | The web UI and JSON API over a config: runs, ledgers, approvals, start forms. `startApp(config)`                                 |
| [`@sanoma/testing`](packages/testing)             | `startTestWorker` and `testDatabaseUrl` for workflow tests, and the connectors' fakes re-exported                                |
| [`@sanoma/connector-ghost`](connectors/ghost)     | Ghost operations (posts); `./fake` is an in-memory Ghost                                                                         |
| [`@sanoma/connector-resend`](connectors/resend)   | Resend operations (broadcasts); `./fake` is an in-memory Resend                                                                  |
| [`@sanoma/connector-bluesky`](connectors/bluesky) | Bluesky operations (posts); `./fake` is an in-memory Bluesky                                                                     |

The other directories under `packages/` and `modules/` are placeholders for parts that are not written yet.

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

Inside the repo, `@sanoma/*` imports resolve to each package's `src/` (via `paths` in `tsconfig.json` and aliases in `vitest.config.ts`), so tests and typechecks need no build. Published packages ship only the compiled `dist/`.

## License

[Apache License 2.0](LICENSE).

## Contributing

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). Sign off every commit with `git commit -s`. See the org-wide contributing guide, code of conduct and security policy in [`Sanoma-AI/.github`](https://github.com/Sanoma-AI/.github).
