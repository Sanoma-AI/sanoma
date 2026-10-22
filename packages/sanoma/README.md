# sanoma

One command over a company repo: `sanoma` runs its workflows and the app, `sanoma check` checks it, `sanoma env` writes its `.env.example`, `sanoma ledger export` exports a run. It also carries the surface a workflow imports (`defineWorkflow`, `defineConfig` and the types), so a repo depends on `sanoma` and its connectors, and writes no `worker.ts`, `app.ts`, compose file or vitest config.

## Start a company

```sh
mkdir acme && cd acme
npx sanoma
```

In an empty directory (dotfiles aside), `sanoma` starts a company there, then runs it: it copies the template this package ships (`template/`: `sanoma.config.ts`, a `publish-post` workflow with its scenarios, `policies/policy.cedar`, `resources/people.ts` with you as its first person (your GitHub login as `gh` is signed in, else this machine's user name, named as git's `user.name`), an empty `resources/` tree, `AGENTS.md`, `.env.example`), names the package after the directory, writes `.env` with the default `SANOMA_DATABASE_URL` and a new `SANOMA_SECRETS_KEY` (keeping what a `.env` there already sets), commits what it wrote (never a dotfile that was already there) as the first commit of a git repository on `main`, "Start a Sanoma company", as your git user, then installs with the package manager that ran it (`npm_config_user_agent`; pnpm when it names none) and adds the lockfile to that commit. The `sanoma` it installed then serves the company. Without git or a git user it stops before writing anything; a failed install leaves the commit, to install and run `sanoma` again in. A directory holding anything else and no `sanoma.config.ts` is refused, as for every command.

## Install

```sh
npm install sanoma @sanoma-ai/connector-ghost
```

`sanoma` brings `@sanoma-ai/workflows`, `@sanoma-ai/app`, `zod`, `typescript`, `@types/node` and `oxlint` with it: a repo installs nothing else but its connectors. Node's types reach the repo's `tsc` through `sanoma` itself (its declarations reference them, resolved from where it is installed), under pnpm, npm or a link alike, so a repo lists no `@types/node`. A repo that lists its own of another major gets two sets of Node's declarations, which conflict: keep one, by matching sanoma's or letting the installer dedupe them. A tsconfig project that imports nothing from `sanoma` (a scripts directory with a tsconfig of its own, say) gets none this way: it sets `"types": ["node"]` and lists `@types/node` itself. Node 24.2 or later, but not 25 (the bin uses `import.meta.main`, and Cucumber, which runs the scenarios, does not support 25); Docker for the Postgres it starts when none answers.

A repo holds `sanoma.config.ts` at its root, with `workflows/`, optional `policies/` (Cedar files), `resources/` (data files, the people among them) and `scenarios/` (feature files) beside it, and a `tsconfig.json` that extends the one this package ships:

```json
{
  "extends": "sanoma/tsconfig.json",
  "include": ["sanoma.config.ts", "workflows", "resources"]
}
```

```ts
// sanoma.config.ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";
import publish from "./workflows/publish.ts";

export default defineConfig({
  workflows: [publish],
  connectors: [ghost],
});
```

Each connector carries its driver and its fake, so the config names neither. The rest is the repo's layout: the app's name is `package.json`'s `name`, the scenarios are `scenarios/`, the data files `resources/` and the policies `policies/**/*.cedar`, beside `sanoma.config.ts` (see [People and policies](#people-and-policies)). The ledger is Postgres's, on the config's database; `ledger: jsonlLedger(dir)` keeps it in files instead.

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

A workflow imports from `sanoma` what the lint lets it (`defineWorkflow`, `mayDecide`, `errorCode`, `z`, and types); `zod` itself and `@sanoma-ai/workflows` are accepted too. The config file imports `defineConfig` (and a ledger store, `jsonlLedger`, `memoryLedger` or `postgresLedger`, when it names one) from `sanoma`, and its connectors from their packages. A site, `sites/<name>/` (pages the app serves under `/sites/<name>/`), imports `defineSite`, the app's route APIs (`Link`, `Outlet`, `useNavigate`, …) and `api`, which calls the company's operations and workflows as the person on the page ([calling operations and workflows](https://www.npmjs.com/package/@sanoma-ai/app#calling-operations-and-workflows)), from `sanoma/site`, and `createFileRoute` from `@tanstack/react-router`; the [app's README](https://www.npmjs.com/package/@sanoma-ai/app#a-sites-imports) has the whole list. A data file under `resources/` imports `secret` and `sanoma` (the people types) from `sanoma/resources`, and `resources/data.ts`, the company's [collections](../workflows/README.md#collections), imports `collection` from `sanoma/data` and nothing else:

```ts
// resources/data.ts
import { collection } from "sanoma/data";

export const outbound = collection({
  name: "outbound",
  key: "company",
  fields: { company: "text", stage: { enum: ["researched", "contacted", "won", "lost"] }, owner: "person" },
});
```

Every command that loads the config imports `resources/data.ts` too, when there is one, and adds its collections to the config's `collections` (each of its exports must be one), so `sanoma.config.ts` does not list them. A workflow that calls `ctx.data.outbound.get` imports `outbound` from `../resources/data.ts` to name it in `uses`: the one file outside `workflows/` the lint lets it import.

## People and policies

`resources/people.ts` declares who uses the company's app, the agents that act in it and the groups ([people](https://www.npmjs.com/package/@sanoma-ai/workflows#people)), and `policies/*.cedar` who may do what ([policies](https://www.npmjs.com/package/@sanoma-ai/workflows#policies)):

```ts
// resources/people.ts
import { sanoma } from "sanoma/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Ortiz", email: "ada@acme.test", github: "ada-ortiz" });
export const bo = sanoma.person({ id: "bo" });
export const editor = sanoma.group({ name: "editor", members: [ada] });
```

```cedar
// policies/policy.cedar
@hold("editor")
@title("Review before it goes out")
forbid (principal, action in [Sanoma::Action::"effect:publish", Sanoma::Action::"effect:send"], resource)
unless { principal in Sanoma::Group::"editor" };
```

Only a declared person signs in to the app (on this machine by picking their name; with GitHub sign-in by their verified email, then their `github` login), starts a run, calls an operation or decides an approval, and nobody decides an approval on a run they started while someone else in the group could (a founder alone in a group decides their own, and the ledger says so). Everything is allowed unless a `forbid` refuses it: one with `@hold` waits for that group's or person's approval, one without is denied with its `@reason`. Write them against `.sanoma/schema.cedarschema`, which `sanoma check` and `sanoma` write from the config: each operation's id as an action in its effect's group, `workflow:<name>` for a run's start, the groups the people file declares, and each operation's input as `context.input`. `sanoma check` reports a policy problem at its place and runs no scenario until there are none; `sanoma` refuses to start on one. A scenario runs as the agent `scenarios` unless it says who is acting (`Given bo is acting`), and checks the policy with `Then ghost.post.publish was held for group "editor"` and `Then <op> was denied with "<reason>"`. The app's Permissions page shows what the policies answer for each group.

## Commands

Run them from the directory that holds `sanoma.config.ts`. Each loads `.env` there first, when there is one (a variable already set wins), then the config.

| Command                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sanoma`                                      | Makes `SANOMA_SECRETS_KEY`, which encrypts the stored credentials, when the environment and `.env` have none, appending it to `.env` with one line saying so; makes sure Postgres answers (see [Postgres](#postgres)), then starts the worker (promoted, so a local worker takes every queued run) and the app in one process, and prints `<appName> running <workflows>` and `<appName> at http://127.0.0.1:3000; ctrl-c to stop`; the worker says `sanoma: 2 of 5 connectors not configured yet: ghost, resend; …` first when some vendors' variables are missing or invalid (a call to one fails, naming them, until they are set; nothing when all are set). When the repo has [sites](#sites), it serves the app and the sites from a dev server that shows each edit as it is saved (see [Developing a site](#developing-a-site)). In [dev mode](#dev-mode) it runs them in a child it restarts. In an empty directory it first [starts a company](#start-a-company). The worker and the app are given the repo's git checkout as their `source`, which commits to the current branch. |
| `sanoma worker`, `sanoma app`                 | One of the two alone, for a deployment that runs them apart (`app` builds the app with the [sites](#sites)). Neither touches Docker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sanoma check`                                | Writes [`.sanoma/api.ts`](#sites) and `.sanoma/schema.cedarschema` first, each when it changed; then `tsc -p tsconfig.json`; oxlint over `workflows/`, `resources/` and `sites/` (those that exist) with the repo's `.oxlintrc.json`, written when missing (see [the lint](#the-lint)); every problem `describeConfig` finds (an import a workflow may not make, what its graph cannot draw, a data file outside the subset: what the worker would refuse; a site's call to a workflow, collection or operation the config does not have); every problem in the [policies](#people-and-policies), at its `file:line:col` with the policy's id; with [sites](#sites), the app built with them, `tsc -p sites/tsconfig.json` and what is wrong under `content/`; then, unless the policies have a problem, every scenario against the fakes, on a database of its own (`<database>_check`), each step that did not hold a problem. Prints each problem on a line, `file:line:col: message` or `scenario › step: message`, and exits 1 when there is one. No vitest.                            |
| `sanoma env [--check]`                        | Writes `.env.example`: the variables `sanoma` reads, then every variable the connectors' drivers declare, by vendor, with its description; optional ones commented out. `--check` writes nothing and exits 1 with "`.env.example` is out of date: run `sanoma env`" when the file differs, for CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sanoma ledger export <runId> [--out <file>]` | A run's ledger records from the config's store (the Postgres ledger on its database when it names none), as JSON lines (the shape `jsonlLedger` keeps), to stdout or `--out`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sanoma --help`                               | The usage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Exit codes: 2 for a mistake in the call or the repo (no `sanoma.config.ts`, an unknown command or option, a bad argument), printed with the usage where it helps; 1 for failed checks and failures while running; 0 otherwise. `SANOMA_APP_PORT` is the app's port (default 3000; 0 for any free port, which the printed address reports). `SANOMA_APP_HOST` is its address (default 127.0.0.1); any other needs [GitHub sign-in](../app/README.md#github), which `SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET` turn on (both or neither, with `SANOMA_SECRETS_KEY` set; on a host beyond this machine, or with one of them set, the other may be the stored one the app's Go live page saved when it created the GitHub App); a mistake in them exits 2 before anything starts, as does a problem in the policies. On SIGINT or SIGTERM the app, then the worker, stop, and the process exits 0.

## Postgres

The worker and the app run on `SANOMA_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma`), or the config's `databaseUrl`. `sanoma` (through `sanoma serve`) and `sanoma check` first probe it (`SELECT 1` as its user; `check` meanwhile runs tsc, oxlint and reads the config, and waits for Postgres only before the scenarios). When nothing answers and the host is this machine (`localhost`, `127.x.x.x`, `::1`), they start Postgres in Docker: the container `sanoma-<appName>-postgres` is started when it exists and is stopped, created from `postgres:17` on the URL's port, user, password and database when it does not, and left alone when it runs; then the probe is repeated until it answers (up to a minute). A container is never removed: `docker rm sanoma-<appName>-postgres` does that. A server that answers with an error (a wrong password), nothing answering at another host, and a missing Docker each stop the command with a message.

## `.env.example`

`sanoma env` keeps `.env.example` the manual of the variables: `SANOMA_DATABASE_URL`, `SANOMA_APP_PORT`, `SANOMA_APP_HOST` and the GitHub sign-in variables first, with their defaults, then a block per vendor in the connectors' order, each variable its driver's `env` declares with its `.describe()` text. A required variable is `NAME=`; an optional one is commented out, `# NAME=`, with `Optional.` before its description. The same config gives the same text, which `--check` compares byte for byte. Copy it to `.env` (ignored by git) and fill it in; the vendor variables can also be set on the app's connector pages, where a value from the environment wins over a stored one.

## The lint

`sanoma check` lints `workflows/`, `resources/` and `sites/`, those that exist, with oxlint, run in the repo's root on the repo's own `.oxlintrc.json`, so an editor's oxlint reads the same file and the rules' `workflows/**` globs match against the root. `sanoma check` writes that file when there is none:

```json
{
  "extends": ["./node_modules/sanoma/oxlint.json"]
}
```

`sanoma/oxlint.json` is self-contained (it extends nothing): `@sanoma-ai/workflows`'s rules (the clock, randomness, the network, the environment, the imports a workflow may make, the data-file subset, with its plugin inside `sanoma`), a site's (client code only: no server function, `*.server.*` file or route `server` handlers, no import of the runtime, a connector, Postgres, DBOS, Node's modules or TanStack Start, no relative import out of `sites/`, no `virtual:` module (content comes through `content`), no `process` or `require`; types may be imported from anywhere; `sites/__virtual.ts`, the build's listing, aside) and the rules this repo holds its own code to. Add your own rules beside the `extends`; `sanoma check` leaves an existing file alone.

## Sites

A folder under `sites/` with a `routes/` directory is a site: TanStack Router file routes the app serves under `/sites/<name>`, in its shell (see [`@sanoma-ai/app`'s Sites](../app/README.md#sites)). A route file imports `createFileRoute` from `@tanstack/react-router`; the repo installs nothing for it but `sanoma`.

- `sanoma app` (and `sanoma` when `SANOMA_APP_HOST` is another machine's) builds the app with the repo's sites before anything starts (`building the app with 1 site (hello)`), into `.sanoma/app/build/<key>`, and serve that build. The key covers the app's version and every file under `sites/` and `content/`, so a start with nothing changed reuses the build (`app build up to date`). With no site, they serve the build the app ships and write nothing under `.sanoma/` but `api.ts`. A build that fails stops the command before the worker starts.
- `.sanoma/api.ts` is the generated SDK: `sanoma check` (first, before tsc), and `sanoma`, `sanoma serve` and `sanoma app` at start, write it from the config when its text changed, with sites or without; while `sanoma` serves the sites from its dev server, it writes it again (`wrote .sanoma/api.ts`) when `sanoma.config.ts` or any TypeScript file in the repo outside `sites/`, `.sanoma/` and `node_modules/` changes. It types `api` from `sanoma/site`: `api.<workflow>` (the workflow's name in camelCase, `WorkflowFn` of its input), `api.<vendor>.<resource>.<op>` for each operation a person may call directly (a vendor's read, `OpFn` of its input) and `api.data.<collection>` (`CollectionApi` of the collection's record), each with its title and descriptions as JSDoc, so whoever writes a site sees what each call is and `tsc -p sites/tsconfig.json` refuses a call that does not fit. The sites' tsconfig is the only one that reads it: the repo's root `tsconfig.json` (Node, no DOM) must not include it. A workflow whose api name another workflow, a vendor or `data` has is left out of it, and `sanoma check` reports it. Never edit it.
- `sanoma check`, when there is a site, writes the sites' generated files, then, beside tsc, oxlint and the config, builds the app with the sites (reused when nothing changed) and runs `tsc -p sites/tsconfig.json`, which types every `Link` against every page of the app and the sites. Each of these is a problem: a type error at its `file:line:col`; two pages claiming one path (`More than one page claims /sites/hello/: …`); a site importing server code (`sites/hello/routes/index.tsx:4:28: Import denied in client environment: "@sanoma-ai/workflows"`); a folder whose name is not one URL segment (`sites/<name>: a site's folder name is a URL segment (lowercase letters, digits and dashes)`), which the app does not mount; and under `content/`, front matter that is not a YAML mapping, at its line (`content/posts/bad.md:2:1: front matter: Tabs are not allowed as indentation`), or a folder or file whose name is not a URL segment, which the sites do not see.
- `content/` holds the Markdown a site reads through `content` from `sanoma/site` ([`@sanoma-ai/app`'s Content](../app/README.md#content)): `content/<kind>/<slug>.md`, front matter and a body, found by convention as `sites/` is. `.sanoma/content.ts` types it from the files' front matter, written with the sites' generated files and, on the dev server, again when a file under `content/` changes. A file with `draft: true` shows on the dev server and never in a build.

### Developing a site

`sanoma` serves the app and the sites from Vite's dev server instead of a build (`serving the app with 1 site (hello) from Vite's dev server: edits show as they are saved`), behind the same login, and writes no build:

- An edit to a site's file shows in the open page as it is saved, without a reload, the page's state kept (hot module replacement); the server's render of the page follows on the next request.
- A file saved under `content/` shows on the next render of a page that reads it, drafts included, with no restart, and `.sanoma/content.ts` is written again.
- A new page, or a new site folder, is live once its first route file is written: the route tree is regenerated and open pages reload, with no restart. A Tailwind class in a new file is styled too.
- A change to `sites/__virtual.ts` itself needs a restart: the route generator loads that file once. `sanoma` writes it; never edit it.
- `sanoma check` beside it builds the app with the same route options, so it leaves the dev server's route tree alone.
- The dev server listens on this machine only: with `SANOMA_APP_HOST` naming another, `sanoma` builds the sites and serves the build, as `sanoma app` does.

## Generated files

| File                                                  | Written by                                | Commit it       |
| ----------------------------------------------------- | ----------------------------------------- | --------------- |
| `.env.example`                                        | `sanoma env`                              | yes             |
| `.oxlintrc.json`                                      | `sanoma check`, when missing              | yes             |
| `sites/__virtual.ts`                                  | `sanoma` and `sanoma check`, with sites   | yes             |
| `sites/tsconfig.json`                                 | `sanoma` and `sanoma check`, when missing | yes             |
| `.sanoma/api.ts` (the sites' typed `api`)             | `sanoma` and `sanoma check`               | no (`.sanoma/`) |
| `.sanoma/content.ts` (the sites' typed `content`)     | `sanoma` and `sanoma check`, with sites   | no (`.sanoma/`) |
| `.sanoma/app/` (the route tree, its tsconfig, builds) | `sanoma` and `sanoma check`, with sites   | no (`.sanoma/`) |

## Dev mode

When the repo's `node_modules/sanoma` or any `node_modules/@sanoma-ai/*` is a link into a sanoma checkout (`pnpm link`), or `SANOMA_DEV_REPO` names one, `sanoma` runs `sanoma serve --dev` in a child process (serving the [sites](#developing-a-site) as `sanoma` does) and, in every linked package's directory, its `pnpm run watch` (each package's own watch build: `tsc --watch`, and `vite build --watch` too for the app). A change under any linked package's `dist/` restarts the child, after three quarters of a second of quiet (with sites, except the app's own pages in `dist/client` and `dist/server`: the dev server serves the app's source from the checkout and hot-updates it), one restart at a time; a child that exits on its own is reported and started again on the next change. The child and each watch run in a process group of their own, so a terminal's ctrl-c reaches `sanoma` alone, which then ends each group (SIGTERM, SIGKILL after 5 seconds) and exits.

Linking some of `sanoma`, `@sanoma-ai/workflows`, `@sanoma-ai/app` and `@sanoma-ai/bridge` and not the others works, with two copies of a package in one process (the linked one, and the one an installed package depends on), and `sanoma` says which still come from their tarballs before it starts the child: `dev mode: sanoma, @sanoma-ai/app, @sanoma-ai/bridge still come from their tarballs: edits to them in the checkout will not show until you pnpm link them too`. Link all four to run the checkout alone.

## Hosting it yourself

`sanoma worker` and `sanoma app` are the deployment's two processes. A host that composes its own process keeps `startWorker` from `@sanoma-ai/workflows` and `startApp` from `@sanoma-ai/app`, which the bin runs.

[`runtime/`](runtime/Dockerfile) is the image a container host runs: Node 24, git, pnpm (corepack) and `provider-bridge`, and no company code. At start it clones `SANOMA_SOURCE` at `SANOMA_REVISION` (with `SANOMA_SOURCE_TOKEN` as an HTTP header when set), runs `pnpm install --frozen-lockfile` and `sanoma serve` on `0.0.0.0` and `PORT` (default 3000); the host passes `SANOMA_DATABASE_URL`, `SANOMA_SECRETS_KEY` and, as the app is not on loopback, the `SANOMA_GITHUB_*` sign-in variables too. Its health check is the app's `/healthz`. A repo with [sites](#sites) is built at start, as `sanoma serve` does anywhere, into `.sanoma/app/` in the clone: the app listens once the build is done (the health check's start period allows 5 minutes for the clone, the install and the build); the image itself holds no build. `provider-bridge` is built from source at a pinned commit; `--build-arg BRIDGE_FROM=release --build-arg BRIDGE_VERSION=<x.y.z>` downloads a release instead. CI builds the image and pushes it nowhere; it runs no company in it, so neither a site's build.

Status: early (0.x). License: FSL-1.1-ALv2.
