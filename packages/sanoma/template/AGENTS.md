# A company on Sanoma

This repository is a company's operations as code, run by [Sanoma](https://github.com/Sanoma-AI/sanoma): workflows that call vendors through connectors, the people who use it, Cedar policies that decide which calls and runs wait for someone's approval or are refused, and the vendor objects the company owns, declared as data. `npx sanoma` in an empty directory started it; `sanoma` from npm runs it. The `sanoma` package's README (`node_modules/sanoma/README.md`) is the manual.

## Layout

```
sanoma.config.ts     the workflows and the connectors
workflows/           one workflow per file (defineWorkflow)
policies/*.cedar     who may do what: Cedar forbids, each a hold for an approver (@hold) or a deny (@reason)
resources/           data files: the vendor objects this company declares, by area
resources/data.ts    collections: the company's own records (collection, from sanoma/data)
resources/people.ts  who may use the app, the agents, and the groups (sanoma.person, .agent and .group, from sanoma/resources)
scenarios/           Gherkin: how each workflow should go against the connectors' fakes
sites/               pages the app serves under /sites/<name>: sites/<name>/routes/ holds TanStack Router file routes (none yet)
.env                 this machine's settings and secrets, never committed (SANOMA_SECRETS_KEY encrypts stored credentials)
```

The app's name is `package.json`'s `name`. `.env.example` (written by `sanoma env`) and `.oxlintrc.json` (written by `sanoma check` when missing) are generated, and so are `sites/__virtual.ts` and `sites/tsconfig.json` once there is a site: commit them, never edit them. `.sanoma/` holds what `sanoma` builds (ignored), `.sanoma/api.ts` among it: the typed `api` for sites, and `.sanoma/schema.cedarschema`, the schema the policies are checked against, both generated from the config by `sanoma check` and at start, never edited.

## Run

With the package manager whose lockfile is here (`npm run <script>`, `pnpm <script>`, …):

```sh
npm run dev         # Postgres (in Docker when nothing answers), the worker and the app; the app at the printed address
npm run check       # tsc, the lint, the policies, what the worker would refuse, the sites' build and types, and every scenario
npm run env         # rewrites .env.example from the connectors' variables
```

## Rules

- A workflow imports only from `sanoma`, its connectors and relative files, and does the same thing every time it is replayed: `ctx.now()` and `ctx.sleep()`, never `Date` or timers; configuration comes in as input, never from `process.env`. The `check` script holds workflows and data files to this.
- Define each workflow's `name` as a string literal: the app finds the workflow in its file by it.
- Every operation a workflow calls is listed in its `uses`; add the connector to `sanoma.config.ts` and to `package.json`.
- Declare the company's own records as collections in `resources/data.ts`, which imports only `collection` from `sanoma/data` and holds nothing else: the runtime imports it, and so does a workflow that names a collection's operations (`import { outbound } from "../resources/data.ts"`, the one file outside `workflows/` a workflow may import). Every other data file is read, never run.
- Only a person declared with `sanoma.person` (in `resources/people.ts` by convention, a data file like any other) signs in to the app (by `id` on this machine; with GitHub sign-in by email, then `github` login), starts a run, calls an operation or decides an approval, in the groups that list them (`sanoma.group({ name, members: [ada, refundBot] })`, the one place a membership is written). An agent (`sanoma.agent({ id, onBehalfOf: bo })`) is in the group `agents` besides; it never signs in. A new colleague is an edit to that file before their first sign-in. Nobody decides an approval on a run they started while someone else in the group could; alone in it, they decide, and the ledger says so.
- The policies are `policies/*.cedar`, written in [Cedar](https://docs.cedarpolicy.com) against `.sanoma/schema.cedarschema`. Everything is allowed unless a `forbid` refuses it; the runtime writes the one `permit`, so a `permit` here is a problem. A `forbid` with `@hold("<group>")` (or a person's id, or `"on-behalf-of"` for whom an agent acts) waits for that approver, with `@title` as its title in the Inbox, and the run goes on once they approve; one without `@hold` is denied, with `@reason` as the message. Actions are each operation's id (`Sanoma::Action::"ghost.post.publish"`), in its effect's group (`Sanoma::Action::"effect:publish"`), and `Sanoma::Action::"workflow:<name>"` for starting a run; `principal in Sanoma::Group::"editor"` is membership; `context.input` is the call's input. The app's Permissions page shows what they answer for each group. The `check` script reports a policy problem (a field, action or group the schema lacks, a `@hold` naming no one declared) at its `file:line:col`, and runs no scenario until there are none; `npm run dev` refuses to start on them.
- Describe each workflow's expected runs in `scenarios/<workflow>/<name>.feature`, and run the `check` script after every change. A scenario runs as the runtime's own agent `scenarios` unless it says who is acting (`Given reviewer is acting`), and checks the policy with `Then <op> was held for group "<group>"` and `Then <op> was denied with "<reason>"`; a scenario's approver (`is approved by reviewer`) must be declared. `reviewer` in `resources/people.ts` is a stand-in who can sign in and approve: replace them with a real colleague, in the scenarios too.
- A site, `sites/<name>/routes/` (pages the app serves under `/sites/<name>/`, with an optional `sites/<name>/site.ts` naming it with `defineSite`), is browser code: no server code, credential or `process.env` under `sites/`, which the `check` script holds it to, and the folder's name is its URL segment (lowercase letters, digits and dashes). Its route files import `createFileRoute` from `@tanstack/react-router`, routing (`Link`, `Outlet`, `useNavigate`, `defineSite`, …) from `sanoma/site`, and UI from `@sanoma-ai/app/ui`: the app's own components (`Button`, `Card`, `Table`, `Region`, `Facts`, …) and `<RunForm workflow="<name>" />`, the app's start form for a workflow. A page reaches data and workflows only through `api` from `sanoma/site`, as the person on the page: `api.data.<collection>.list()`, a vendor's read such as `api.<vendor>.<resource>.get(…)`, `await api.<workflow>(input)` or `api.<workflow>.start(input)` (the workflow's name in camelCase); see the app package's README (Sites). Name what a page calls with literals (`workflow="announce"`, `api.announce.start(…)`, not a variable): the app reads a site's calls from its code to list them under each workflow's Used by, and the `check` script fails on a call to a workflow, collection or operation that does not exist. While the `dev` script runs, an edit to a site shows in the open page as it is saved, and a new site folder is live without a restart.
- Never put credentials in a file here. They live in `.env` or on the app's connector pages, which store them encrypted in the database.
