# sanoma/app

A web UI for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces: it renders from `describeConfig(config)`, the config's ledger store and Postgres. The only workflow code it reads is each workflow's `run`, once at start, to draw its outline. It runs no workflows itself. The page talks to the server through TanStack Start server functions, its only HTTP surface besides the login's routes and the GitHub App's manifest flow (`/setup/github/`), and on a [public site's](#public-sites) own host only two of them, `callFn` and `getActor`, beside the site's login's routes and its robots.txt and sitemap; scripts and agents reach the same runs through [`SanomaClient`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#building-your-own-ui), over the same Postgres.

It is a [TanStack Start](https://tanstack.com/start) app (React, TanStack Router, Query and Form): one fetch handler (`appHandler`) over the company's [snapshot](#the-app-bundle) and its client, served by `startApp` from Node, and by Cloudflare's workerd from [the app bundle](#the-app-bundle).

## Usage

```sh
npm install sanoma
```

The [`sanoma`](https://www.npmjs.com/package/sanoma) bin runs the app beside the worker over a repo's `sanoma.config.ts`; `startApp` remains for a custom host. Run it beside the worker, from the same config:

```ts
import { startApp } from "sanoma/app";
import config from "./sanoma.config.ts";

const app = await startApp(config, { port: 3000 });
console.log(app.url); // http://127.0.0.1:3000
```

`startApp` checks the config first and throws what the worker would refuse (missing credentials refuse nothing: the connector pages show and set them). The worker and the app share the config's Postgres (`databaseUrl`, else `SANOMA_DATABASE_URL`): the runs, connection metadata, built-in stored credentials and, by default, the ledger, which `postgresLedger` keeps in a table there, so the app reads what a worker in any process records. A config with a `jsonlLedger` shares its directory instead, and a `memoryLedger` is visible only in the process that wrote it. A run that has started but has no records in the app's ledger says so on its page, since the likeliest cause is an app on another ledger than the worker's (another database, or a `jsonlLedger` directory relative to another working directory). Without `port`, the app takes any free port and reports it in `app.url`. `app.close()` stops it.

## Sites

Moved to the docs: [Sites](https://docs.sanoma.work/sites/overview/#sites).

### A site's imports

Moved to the docs: [A site's imports](https://docs.sanoma.work/sites/imports/).

### The kit and RunForm

Moved to the docs: [The kit and RunForm](https://docs.sanoma.work/sites/kit/).

### A site's own stylesheet

Moved to the docs: [A site's own stylesheet](https://docs.sanoma.work/sites/stylesheet/).

#### The kit on a site

Moved to the docs: [A site's own stylesheet](https://docs.sanoma.work/sites/stylesheet/#the-kit-on-a-site).

### Calling operations and workflows

Moved to the docs: [Calling operations and workflows](https://docs.sanoma.work/sites/calling/).

### Agents over MCP

Moved to the docs: [Agents over MCP](https://docs.sanoma.work/start/agents-over-mcp/).

### Content

Moved to the docs: [Content](https://docs.sanoma.work/sites/content/).

### Public sites

Moved to the docs: [Public sites](https://docs.sanoma.work/sites/public-sites/).

### Languages

Moved to the docs: [Languages](https://docs.sanoma.work/sites/languages/).

## The app bundle

Moved to the docs: [The app bundle](https://docs.sanoma.work/hosting/app-bundle/).

## Screens

Moved to the docs: [The app's screens](https://docs.sanoma.work/start/the-app/).

### Connection management

Moved to the docs: [The app's screens](https://docs.sanoma.work/start/the-app/#connection-management).

### Run graph

Moved to the docs: [The app's screens](https://docs.sanoma.work/start/the-app/#run-graph).

### Outline

Moved to the docs: [The app's screens](https://docs.sanoma.work/start/the-app/#outline).

## Login

Moved to the docs: [Login](https://docs.sanoma.work/sites/login/).

### No login, on this machine

Moved to the docs: [Login](https://docs.sanoma.work/sites/login/#no-login-on-this-machine).

### Staff sign-in on a host

Moved to the docs: [Login](https://docs.sanoma.work/sites/login/#staff-sign-in-on-a-host).

### Your own

Moved to the docs: [Login](https://docs.sanoma.work/sites/login/#your-own).

## Developing

In the repo, `pnpm --filter sanoma build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` and `./build` entries). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: FSL-1.1-ALv2.
