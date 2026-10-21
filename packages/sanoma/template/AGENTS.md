# A company on Sanoma

This repository is a company's operations as code, run by [Sanoma](https://github.com/Sanoma-AI/sanoma): workflows that call vendors through connectors, a policy that decides which calls need a person's approval, and the vendor objects the company owns, declared as data. `npx sanoma` in an empty directory started it; `sanoma` from npm runs it. The `sanoma` package's README (`node_modules/sanoma/README.md`) is the manual.

## Layout

```
sanoma.config.ts     the workflows, the connectors and the policy
workflows/           one workflow per file (defineWorkflow)
policies/policy.ts   which calls need whose approval (definePolicy)
resources/           data files: the vendor objects this company declares, by area
resources/data.ts    collections: the company's own records (collection, from sanoma/data)
scenarios/           Gherkin: how each workflow should go against the connectors' fakes
sites/               pages the app serves under /sites/<name>: sites/<name>/routes/ holds TanStack Router file routes (none yet)
.env                 this machine's settings and secrets, never committed (SANOMA_SECRETS_KEY encrypts stored credentials)
```

The app's name is `package.json`'s `name`. `.env.example` (written by `sanoma env`) and `.oxlintrc.json` (written by `sanoma check` when missing) are generated, and so are `sites/__virtual.ts` and `sites/tsconfig.json` once there is a site: commit them, never edit them. `.sanoma/` holds what `sanoma` builds (ignored).

## Run

With the package manager whose lockfile is here (`npm run <script>`, `pnpm <script>`, …):

```sh
npm run dev         # Postgres (in Docker when nothing answers), the worker and the app; the app at the printed address
npm run check       # tsc, the lint, what the worker would refuse, the sites' build and types, and every scenario
npm run env         # rewrites .env.example from the connectors' variables
```

## Rules

- A workflow imports only from `sanoma`, its connectors and relative files, and does the same thing every time it is replayed: `ctx.now()` and `ctx.sleep()`, never `Date` or timers; configuration comes in as input, never from `process.env`. The `check` script holds workflows, policies and data files to this.
- Define each workflow's `name` as a string literal: the app finds the workflow in its file by it.
- Every operation a workflow calls is listed in its `uses`; add the connector to `sanoma.config.ts` and to `package.json`.
- Declare the company's own records as collections in `resources/data.ts`, which imports only `collection` from `sanoma/data` and holds nothing else: the runtime imports it, and so does a workflow that names a collection's operations (`import { outbound } from "../resources/data.ts"`, the one file outside `workflows/` a workflow may import). Every other data file is read, never run.
- Describe each workflow's expected runs in `scenarios/<workflow>/<name>.feature`, and run the `check` script after every change.
- A site, `sites/<name>/routes/` (pages the app serves under `/sites/<name>/`, with an optional `sites/<name>/site.ts` naming it with `defineSite`), is browser code: no server code, credential or `process.env` under `sites/`, which the `check` script holds it to, and the folder's name is its URL segment (lowercase letters, digits and dashes). Its route files import `createFileRoute` from `@tanstack/react-router`, routing (`Link`, `Outlet`, `useNavigate`, `defineSite`, …) from `sanoma/site`, and UI from `@sanoma-ai/app/ui`: the app's own components (`Button`, `Card`, `Table`, `Region`, `Facts`, …) and `<RunForm workflow="<name>" />`, the app's start form for a workflow.
- Never put credentials in a file here. They live in `.env` or on the app's connector pages, which store them encrypted in the database.
