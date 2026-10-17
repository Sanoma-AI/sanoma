# sanoma

One command over a company repo: `sanoma` runs its workflows and the app, `sanoma check` checks it, `sanoma env` writes its `.env.example`, `sanoma ledger export` exports a run. It also carries the surface a workflow or policy imports (`defineWorkflow`, `definePolicy`, the decisions, `defineConfig` and the types), so a repo depends on `sanoma` and its connectors, and writes no `worker.ts`, `app.ts`, compose file or vitest config.

## Start a company

```sh
mkdir acme && cd acme
npx sanoma
```

In an empty directory (dotfiles aside), `sanoma` starts a company there, then runs it: it copies the template this package ships (`template/`: `sanoma.config.ts`, a `publish-post` workflow with its scenarios, a policy, an empty `resources/` tree, `AGENTS.md`, `.env.example`), names the package after the directory, writes `.env` with the default `SANOMA_DATABASE_URL` and a new `SANOMA_SECRETS_KEY` (keeping what a `.env` there already sets), installs with the package manager that ran it (`npm_config_user_agent`; pnpm when it names none), and commits everything as the first commit of a git repository on `main`, "Start a Sanoma company", as your git user. The `sanoma` it installed then serves the company. Without a git user it stops before writing anything. A directory holding anything else and no `sanoma.config.ts` is refused, as for every command.

## Install

```sh
npm install sanoma @sanoma-ai/connector-ghost
```

`sanoma` brings `@sanoma-ai/workflows`, `@sanoma-ai/app`, `zod`, `typescript`, `@types/node` and `oxlint` with it: a repo installs nothing else but its connectors. Node's types reach the repo's `tsc` through `sanoma` itself (its declarations reference them, resolved from where it is installed), under pnpm, npm or a link alike, so a repo lists no `@types/node`. A repo that lists its own of another major gets two sets of Node's declarations, which conflict: keep one, by matching sanoma's or letting the installer dedupe them. A tsconfig project that imports nothing from `sanoma` (a scripts directory with a tsconfig of its own, say) gets none this way: it sets `"types": ["node"]` and lists `@types/node` itself. Node 24.2 or later, but not 25 (the bin uses `import.meta.main`, and Cucumber, which runs the scenarios, does not support 25); Docker for the Postgres it starts when none answers.

A repo holds `sanoma.config.ts` at its root, with `workflows/`, `policies/`, optional `resources/` (data files) and `scenarios/` (feature files) beside it, and a `tsconfig.json` that extends the one this package ships:

```json
{
  "extends": "sanoma/tsconfig.json",
  "include": ["sanoma.config.ts", "workflows", "policies", "resources"]
}
```

```ts
// sanoma.config.ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";
import policy from "./policies/policy.ts";
import publish from "./workflows/publish.ts";

export default defineConfig({
  workflows: [publish],
  connectors: [ghost],
  policy,
});
```

Each connector carries its driver and its fake, so the config names neither. The rest is the repo's layout: the app's name is `package.json`'s `name`, the scenarios are `scenarios/` and the data files `resources/`, beside `sanoma.config.ts`. The ledger is Postgres's, on the config's database; `ledger: jsonlLedger(dir)` keeps it in files instead.

```ts
// workflows/publish.ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineWorkflow, z } from "sanoma";

export default defineWorkflow({
  name: "publish",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [ghost.post.publish],
  run: (ctx, { id }) => ctx.ghost.post.publish({ id }),
});
```

A workflow or policy imports from `sanoma` what the lint lets it (`defineWorkflow`, `definePolicy`, `allow`, `deny`, `approve`, `approvedFor`, `allowAll`, `mayDecide`, `errorCode`, `z`, and types); `zod` itself and `@sanoma-ai/workflows` are accepted too. The config file imports `defineConfig` (and a ledger store, `jsonlLedger`, `memoryLedger` or `postgresLedger`, when it names one) from `sanoma`, and its connectors from their packages.

## Commands

Run them from the directory that holds `sanoma.config.ts`. Each loads `.env` there first, when there is one (a variable already set wins), then the config.

| Command                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sanoma`                                      | Makes sure Postgres answers (see [Postgres](#postgres)), then starts the worker (promoted, so a local worker takes every queued run) and the app in one process, and prints `<appName> running <workflows>` and `<appName> at http://127.0.0.1:3000; ctrl-c to stop`; the worker says `sanoma: 2 of 5 connectors not configured yet: ghost, resend; …` first when some vendors' variables are missing or invalid (a call to one fails, naming them, until they are set; nothing when all are set). In [dev mode](#dev-mode) it runs them in a child it restarts. In an empty directory it first [starts a company](#start-a-company). The worker and the app are given the repo's git checkout as their `source`, which commits to the current branch. |
| `sanoma worker`, `sanoma app`                 | One of the two alone, for a deployment that runs them apart. Neither touches Docker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `sanoma check`                                | `tsc -p tsconfig.json`; oxlint over `workflows/`, `policies/` and `resources/` with the repo's `.oxlintrc.json`, written when missing (see [the lint](#the-lint)); every problem `describeConfig` finds (an import a workflow may not make, what its graph cannot draw, a data file outside the subset: what the worker would refuse); then every scenario against the fakes, on a database of its own (`<database>_check`), each step that did not hold a problem. Prints each problem on a line, `file:line:col: message` or `scenario › step: message`, and exits 1 when there is one. No vitest.                                                                                                                                                   |
| `sanoma env [--check]`                        | Writes `.env.example`: the variables `sanoma` reads, then every variable the connectors' drivers declare, by vendor, with its description; optional ones commented out. `--check` writes nothing and exits 1 with "`.env.example` is out of date: run `sanoma env`" when the file differs, for CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sanoma ledger export <runId> [--out <file>]` | A run's ledger records from the config's store (the Postgres ledger on its database when it names none), as JSON lines (the shape `jsonlLedger` keeps), to stdout or `--out`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sanoma --help`                               | The usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Exit codes: 2 for a mistake in the call or the repo (no `sanoma.config.ts`, an unknown command or option, a bad argument), printed with the usage where it helps; 1 for failed checks and failures while running; 0 otherwise. `SANOMA_APP_PORT` is the app's port (default 3000; 0 for any free port, which the printed address reports). `SANOMA_APP_HOST` is its address (default 127.0.0.1); any other needs [GitHub sign-in](../app/README.md#github), which `SANOMA_GITHUB_CLIENT_ID`, `SANOMA_GITHUB_CLIENT_SECRET` and `SANOMA_GITHUB_REPO` turn on (all three or none, with `SANOMA_SECRETS_KEY` set); a mistake in them exits 2 before anything starts. On SIGINT or SIGTERM the app, then the worker, stop, and the process exits 0.

## Postgres

The worker and the app run on `SANOMA_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma`), or the config's `databaseUrl`. `sanoma` (through `sanoma serve`) and `sanoma check` first probe it (`SELECT 1` as its user; `check` meanwhile runs tsc, oxlint and reads the config, and waits for Postgres only before the scenarios). When nothing answers and the host is this machine (`localhost`, `127.x.x.x`, `::1`), they start Postgres in Docker: the container `sanoma-<appName>-postgres` is started when it exists and is stopped, created from `postgres:17` on the URL's port, user, password and database when it does not, and left alone when it runs; then the probe is repeated until it answers (up to a minute). A container is never removed: `docker rm sanoma-<appName>-postgres` does that. A server that answers with an error (a wrong password), nothing answering at another host, and a missing Docker each stop the command with a message.

## `.env.example`

`sanoma env` keeps `.env.example` the manual of the variables: `SANOMA_DATABASE_URL`, `SANOMA_APP_PORT`, `SANOMA_APP_HOST` and the GitHub sign-in variables first, with their defaults, then a block per vendor in the connectors' order, each variable its driver's `env` declares with its `.describe()` text. A required variable is `NAME=`; an optional one is commented out, `# NAME=`, with `Optional.` before its description. The same config gives the same text, which `--check` compares byte for byte. Copy it to `.env` (ignored by git) and fill it in; the vendor variables can also be set on the app's connector pages, where a value from the environment wins over a stored one.

## The lint

`sanoma check` lints `workflows/`, `policies/` and `resources/` with oxlint, run in the repo's root on the repo's own `.oxlintrc.json`, so an editor's oxlint reads the same file and the rules' `workflows/**` globs match against the root. `sanoma check` writes that file when there is none:

```json
{
  "extends": ["./node_modules/sanoma/oxlint.json"]
}
```

`sanoma/oxlint.json` is self-contained (it extends nothing): `@sanoma-ai/workflows`'s rules (the clock, randomness, the network, the environment, the imports a workflow may make, the data-file subset, with its plugin inside `sanoma`) and the rules this repo holds its own code to. Add your own rules beside the `extends`; `sanoma check` leaves an existing file alone.

## Generated files

| File             | Written by                   | Commit it |
| ---------------- | ---------------------------- | --------- |
| `.env.example`   | `sanoma env`                 | yes       |
| `.oxlintrc.json` | `sanoma check`, when missing | yes       |

## Dev mode

When the repo's `node_modules/sanoma` or any `node_modules/@sanoma-ai/*` is a link into a sanoma checkout (`pnpm link`), or `SANOMA_DEV_REPO` names one, `sanoma` runs `sanoma serve` in a child process and, in every linked package's directory, its `pnpm run watch` (each package's own watch build: `tsc --watch`, and `vite build --watch` too for the app). A change under any linked package's `dist/` restarts the child, after three quarters of a second of quiet, one restart at a time; a child that exits on its own is reported and started again on the next change. The child and each watch run in a process group of their own, so a terminal's ctrl-c reaches `sanoma` alone, which then ends each group (SIGTERM, SIGKILL after 5 seconds) and exits.

Linking some of `sanoma`, `@sanoma-ai/workflows`, `@sanoma-ai/app` and `@sanoma-ai/bridge` and not the others works, with two copies of a package in one process (the linked one, and the one an installed package depends on), and `sanoma` says which still come from their tarballs before it starts the child: `dev mode: sanoma, @sanoma-ai/app, @sanoma-ai/bridge still come from their tarballs: edits to them in the checkout will not show until you pnpm link them too`. Link all four to run the checkout alone.

## Hosting it yourself

`sanoma worker` and `sanoma app` are the deployment's two processes. A host that composes its own process keeps `startWorker` from `@sanoma-ai/workflows` and `startApp` from `@sanoma-ai/app`, which the bin runs.

Status: early (0.x). License: FSL-1.1-ALv2.
