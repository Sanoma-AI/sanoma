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

Moved to the docs: [Sites](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/overview.md#sites).

### A site's imports

Moved to the docs: [A site's imports](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/imports.md).

### The kit and RunForm

Moved to the docs: [The kit and RunForm](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/kit.md).

### A site's own stylesheet

Moved to the docs: [A site's own stylesheet](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/stylesheet.md).

#### The kit on a site

Moved to the docs: [A site's own stylesheet](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/stylesheet.md#the-kit-on-a-site).

### Calling operations and workflows

Moved to the docs: [Calling operations and workflows](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/calling.md).

### Agents over MCP

Moved to the docs: [Agents over MCP](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/start/agents-over-mcp.md).

### Content

Moved to the docs: [Content](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/content.md).

### Public sites

Moved to the docs: [Public sites](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/public-sites.md).

### Languages

Moved to the docs: [Languages](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/languages.md).

## The app bundle

Moved to the docs: [The app bundle](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/hosting/app-bundle.md).

## Screens

Moved to the docs: [The app's screens](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/start/the-app.md).

### Connection management

Moved to the docs: [The app's screens](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/start/the-app.md#connection-management).

### Run graph

Moved to the docs: [The app's screens](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/start/the-app.md#run-graph).

### Outline

Moved to the docs: [The app's screens](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/start/the-app.md#outline).

## Login

Moved to the docs: [Login](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/login.md).

### No login, on this machine

Moved to the docs: [Login](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/login.md#no-login-on-this-machine).

### Staff sign-in on a host

Moved to the docs: [Login](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/login.md#staff-sign-in-on-a-host).

### Your own

Moved to the docs: [Login](https://github.com/Sanoma-AI/sanoma/blob/main/docs-site/src/content/docs/sites/login.md#your-own).

## Developing

In the repo, `pnpm --filter sanoma build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` and `./build` entries). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: FSL-1.1-ALv2.
