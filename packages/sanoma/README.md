# sanoma

One command over a company repo: `sanoma` runs its workflows and the app, `sanoma check` checks it, `sanoma env` writes its `.env.example`, `sanoma ledger export` exports a run. It also carries the surface a workflow or policy imports (`defineWorkflow`, `definePolicy`, the decisions, `defineConfig` and the types), so a repo depends on `sanoma` and its connectors, and writes no `worker.ts`, `app.ts`, compose file or vitest config.

## Install

```sh
npm install sanoma zod @sanoma/connector-ghost
npm install -D @types/node
```

`sanoma` brings `@sanoma/workflows`, `@sanoma/app`, `typescript` and `oxlint` with it. Node 24 or later; Docker for the Postgres it starts when none answers.

A repo holds `sanoma.config.ts` at its root, with `workflows/`, `policies/`, optional `resources/` (data files) and `scenarios/` (feature files) beside it, and a `tsconfig.json` that extends the one this package ships:

```json
{
  "extends": "sanoma/tsconfig.json",
  "include": ["sanoma.config.ts", "workflows", "policies", "resources"]
}
```

```ts
// sanoma.config.ts
import { ghost } from "@sanoma/connector-ghost";
import { ghostDriver } from "@sanoma/connector-ghost/driver";
import { jsonlLedger } from "@sanoma/workflows";
import { defineConfig } from "sanoma";
import policy from "./policies/policy.ts";
import publish from "./workflows/publish.ts";

export default defineConfig({
  workflows: [publish],
  connectors: [ghost],
  drivers: [ghostDriver],
  scenarios: new URL("./scenarios/", import.meta.url),
  policy,
  ledger: jsonlLedger(".sanoma/ledger"),
  appName: "acme",
});
```

```ts
// workflows/publish.ts
import { ghost } from "@sanoma/connector-ghost";
import { defineWorkflow } from "sanoma";
import { z } from "zod";

export default defineWorkflow({
  name: "publish",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [ghost.post.publish],
  run: (ctx, { id }) => ctx.ghost.post.publish({ id }),
});
```

A workflow imports from `sanoma` exactly what it may import from `@sanoma/workflows` (`defineWorkflow`, `definePolicy`, `allow`, `deny`, `approve`, `approvedFor`, `allowAll`, `mayDecide`, `errorCode`, and types), and the lint accepts either package. The config file imports the rest it needs (a ledger store, a connector's driver) from `@sanoma/workflows` and the connectors.

## Commands

Run them from the directory that holds `sanoma.config.ts`. Each loads `.env` there first, when there is one (a variable already set wins), then the config.

| Command                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sanoma`                                      | Makes sure Postgres answers (see [Postgres](#postgres)), then starts the worker (promoted, so a local worker takes every queued run) and the app in one process, and prints `<appName> running <workflows>` and `<appName> at http://127.0.0.1:3000; ctrl-c to stop`. In [dev mode](#dev-mode) it runs them in a child it restarts.                                                                                                                                                                                                                    |
| `sanoma worker`, `sanoma app`                 | One of the two alone, for a deployment that runs them apart. Neither touches Docker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sanoma check`                                | `tsc -p tsconfig.json`; oxlint over `workflows/`, `policies/` and `resources/` with [the shipped config](#the-lint); every problem `describeConfig` finds (an import a workflow may not make, what its graph cannot draw, a data file outside the subset: what the worker would refuse); then every scenario against the fakes, on a database of its own (`<database>_check`), each step that did not hold a problem. Prints each problem on a line, `file:line:col: message` or `scenario › step: message`, and exits 1 when there is one. No vitest. |
| `sanoma env [--check]`                        | Writes `.env.example`: the variables `sanoma` reads, then every variable the drivers declare, by vendor, with its description; optional ones commented out. `--check` writes nothing and exits 1 with "`.env.example` is out of date: run `sanoma env`" when the file differs, for CI.                                                                                                                                                                                                                                                                 |
| `sanoma ledger export <runId> [--out <file>]` | A run's ledger records from the config's store, as JSON lines (the shape `jsonlLedger` keeps), to stdout or `--out`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sanoma --help`                               | The usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Exit codes: 2 for a mistake in the call or the repo (no `sanoma.config.ts`, an unknown command), printed as one line; 1 for failed checks and failures while running; 0 otherwise. `SANOMA_APP_PORT` is the app's port (default 3000; 0 for any free port, which the printed address reports). On SIGINT or SIGTERM the app, then the worker, stop, and the process exits 0.

## Postgres

The worker and the app run on `SANOMA_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma`), or the config's `databaseUrl`. `sanoma` and `sanoma check` first probe it (`SELECT 1` as its user). When nothing answers and the host is this machine (`localhost`, `127.0.0.1`, `::1`), they start Postgres in Docker: the container `sanoma-<appName>-postgres` is started when it exists and is stopped, created from `postgres:17` on the URL's port, user, password and database when it does not, and left alone when it runs; then the probe is repeated until it answers (up to a minute). A container is never removed: `docker rm sanoma-<appName>-postgres` does that. A server that answers with an error (a wrong password), nothing answering at another host, and a missing Docker each stop the command with a message.

## `.env.example`

`sanoma env` keeps `.env.example` the manual of the variables: `SANOMA_DATABASE_URL` and `SANOMA_APP_PORT` first, with their defaults, then a block per vendor in the drivers' order, each variable the driver's `env` declares with its `.describe()` text. A required variable is `NAME=`; an optional one is commented out, `# NAME=`, with `Optional.` before its description. The same config gives the same text, which `--check` compares byte for byte. Copy it to `.env` (ignored by git) and fill it in; the vendor variables can also be set on the app's connector pages, where a value from the environment wins over a stored one.

## The lint

`sanoma check` lints `workflows/`, `policies/` and `resources/` with this package's `oxlint.json`, which carries `@sanoma/workflows`'s rules (the clock, randomness, the network, the environment, the imports a workflow may make, the data-file subset) and the rules this repo holds its own code to. For the same rules in an editor, extend it from a `.oxlintrc.json` in the repo; oxlint resolves `extends` as a file path, so name where the installed packages are:

```json
{
  "extends": ["./node_modules/sanoma/oxlint.json"]
}
```

`sanoma/oxlint.json` extends `@sanoma/workflows/oxlint.json` by its path in `sanoma`'s own `node_modules`; where an installer hoists `@sanoma/workflows` elsewhere, extend both files from your `.oxlintrc.json` instead. `sanoma check` does not depend on that path: for its run it writes the config into the repo's root as `.oxlintrc.sanoma-check.json`, pointing at `@sanoma/workflows`'s where it is, and removes it after.

## Dev mode

When the repo's `node_modules/@sanoma/workflows` is a link into a sanoma checkout (`pnpm link`), or `SANOMA_DEV_REPO` names one, `sanoma` runs the worker and the app in a child process and, for every linked package under `node_modules/@sanoma/` and `node_modules/sanoma`, starts that package's build in watch mode in the checkout (`tsc -p tsconfig.build.json --watch`, and `vite build --watch` for the app). A change under any linked package's `dist/` restarts the child, after three quarters of a second of quiet. Ctrl-c stops the child and the watchers.

## Hosting it yourself

`sanoma worker` and `sanoma app` are the deployment's two processes. A host that composes its own process keeps `startWorker` from `@sanoma/workflows` and `startApp` from `@sanoma/app`, which the bin runs.

Status: early (0.x). License: Apache-2.0.
