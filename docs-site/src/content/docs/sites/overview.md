---
title: Sites
description: "Define a site with file routes and serve it inside the company app or on a public host."
sidebar:
  order: 1
---

Create a `routes/` directory under `sites/<name>/` to define a site. Sanoma serves its TanStack Router pages inside the app at `/sites/<name>`. Import `createFileRoute` from `@tanstack/react-router` in each route file. The repo only needs to install `sanoma`. See [site discovery and builds](#sites).

## Running and checking sites

- `sanoma app` (and `sanoma` when `SANOMA_APP_HOST` is another machine's) builds the app with the repo's sites before anything starts (`building the app with 1 site (hello)`), into `.sanoma/app/build/<key>`, and serve that build. The key covers the app's version and every file under `sites/` and `content/`, so a start with nothing changed reuses the build (`app build up to date`). With no site, they serve the build the app ships and write nothing under `.sanoma/` but `api.ts`. A build that fails stops the command before the worker starts.
- `.sanoma/api.ts` is the generated SDK: `sanoma check` (first, before tsc), and `sanoma`, `sanoma serve` and `sanoma app` at start, write it from the config when its text changed, with sites or without; while `sanoma` serves the sites from its dev server, it writes it again (`wrote .sanoma/api.ts`) when `sanoma.config.ts` or any TypeScript file in the repo outside `sites/`, `.sanoma/` and `node_modules/` changes.

  It types `api` from `sanoma/site`: `api.<workflow>` (the workflow's name in camelCase, `WorkflowFn` of its input), `api.<vendor>.<resource>.<op>` for each operation a person may call directly (a vendor's read, `OpFn` of its input and its declared output, `unknown` when it declares none) and `api.data.<collection>` (`CollectionApi` of the collection's record), each with its title and descriptions as JSDoc, so whoever writes a site sees what each call is and `tsc -p sites/tsconfig.json` refuses a call that does not fit.

  The sites' tsconfig is the only one that reads it: the repo's root `tsconfig.json` (Node, no DOM) must not include it. A workflow whose api name another workflow, a vendor or `data` has is left out of it, and `sanoma check` reports it. Never edit it.
- `sanoma check`, when there is a site, writes the sites' generated files, then, beside tsc, oxlint and the config, builds the app with the sites (reused when nothing changed) and runs `tsc -p sites/tsconfig.json`, which types every `Link` against every page of the app and the sites.

  Each of these is a problem: a type error at its `file:line:col`; two pages claiming one path (`More than one page claims /sites/hello/: …`); a site importing server code (`sites/hello/routes/index.tsx:4:28: Import denied in client environment: "sanoma/workflows"`); a folder whose name is not one URL segment (`sites/<name>: a site's folder name is a URL segment (lowercase letters, digits and dashes)`), which the app does not mount; and under `content/`, front matter that is not a YAML mapping, at its line (`content/posts/bad.md:2:1: front matter: Tabs are not allowed as indentation`), or a folder or file whose name is not a URL segment, which the sites do not see.
- On a public site, `sanoma check` reports each start (`api.signup(…)`, `.start(…)`, a `RunForm`) and each direct call (`api.data.<collection>.<op>`, `api.<vendor>.<resource>.<op>`) that no `permit` in `policies/` could let a visitor make, whatever its `when` and `unless` (one for `anonymous`; on a site with a `login`, for `anonymous` or `visitors`), at its `file:line:col` with the line to add: `sites/www/routes/index.tsx:8:9: a visitor's call to workflow "signup" is refused: no permit in policies/ names anonymous for workflow:signup. Add: permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:signup", resource);`.

  Nothing is held to the policies while they have a problem. Whatever they say, a public site's call of a built-in workflow, or read of a workflow's runs but `.result`, is reported too: the app refuses it to every visitor.

## Files and content

- A site's `public/` folder holds files served as they are, such as a prebuilt script a page loads by its URL: `sites/<name>/public/<path>` is at `/sites/<name>/<path>` on the app (an app's site's at `/sites/<app>/<name>/<path>`), and at `/<path>` on a public site's own host, `<name>.localhost` and its domain. The build copies them into its files without bundling or renaming them, `sanoma` serves them from disk as they are saved, and neither the lint, tsc nor Tailwind reads them.

  A file is as reachable as the site's pages: on the app's host to the people its login lets in, and on a public site's host to every visitor, signed in or not, since a site's login decides what a visitor's calls may read, not who loads its pages.

  The build refuses a file whose name has no extension, one at a page's path, one at a path a site's own host keeps for the app (`robots.txt`, `sitemap.xml`, `assets/`, `auth/`, `sites/`, `_serverFn/`, `__sanoma/`), and one over 25 MiB, the most Cloudflare serves as one of a Worker's assets; it leaves out a dotfile or a dot-folder (`.DS_Store`, `.well-known/`) and a link. A file is answered before a page whose path has a parameter, such as `docs/$slug`.

- `content/` holds the Markdown a site reads through `content` from `sanoma/site` ([`sanoma/app`'s Content](/sites/content/)): `content/<kind>/<slug>.md`, front matter and a body, found by convention as `sites/` is. `.sanoma/content.ts` types it from the files' front matter, written with the sites' generated files and, on the dev server, again when a file under `content/` changes. A file with `draft: true` shows on the dev server and never in a build.

## Sites

A company repo's `sites/<name>/routes/` are TanStack Router file routes the app serves under `/sites/<name>/`, inside its shell, and an app's `apps/<app>/sites/<name>/routes/` under `/sites/<app>/<name>/` (the site `<app>/<name>`, its route ids `/sites/<app>/<name>/…`; a public one answers at `<name>.<app>.localhost`). The package ships its source for that, and a Node-only entry, `sanoma/app/build`, which the `sanoma` bin calls:

```ts
import { buildApp } from "sanoma/app/build";
import { startApp } from "sanoma/app";

const { distDir, built } = await buildApp(repo, { log: console.log });
const app = await startApp(config, { distDir });
```

`buildApp(repo)` builds the app's routes and every site as one TanStack Start build with the repo as Vite's root, and writes only under the repo: `.sanoma/app/routeTree.gen.ts`, Vite's cache in `.sanoma/app/vite/`, and the build in `.sanoma/app/build/<key>/` (`client/` and `server/server.js`), where the key covers the app's version and source directory and every file under `sites/` and `content/`.

All of `.sanoma/app/` is ignored by its own `.gitignore` (`*`), which Tailwind's scan of the repo honours too, so a build never reads its own output, whatever the repo's `.gitignore` says. A build with the same key is reused (`built: false`), and a new one is built beside it and moved into place, so an app serving the old one keeps it.

The server bundle holds everything but the runtime (`sanoma/workflows`, `sanoma/internal/bridge`, DBOS, `pg`, `zod`), which it imports by file URL, resolved from the `sanoma` package's own `package.json` (`manifestFile`), so the worker and the app share one copy.

- A site is client code: a site importing the runtime, a connector, DBOS, `pg` or a `*.server.*` file fails the build with "Import denied".
- A site imports React, TanStack's packages and this app as the app does, from the app's own install: the company repo depends only on `sanoma`.
- Sanoma discovers a site by its `routes/` directory. The folder name must match `/^[a-z][a-z0-9-]*$/` so it fits in one URL segment. `sitesOf(repo)` lists the sites and the refused folders, which the build logs and leaves out. Two pages claiming one path fail the build, naming the path and both files.
- `writeSiteFiles(repo)`, which `buildApp` calls first, writes `sites/__virtual.ts` (the listing the route generator reads; committed, never edited), `sites/tsconfig.json` when missing, `.sanoma/app/tsconfig.json` every time: the app's compiler options (`tsconfig.site.json`, shipped) with its React, TanStack and route tree, so `tsc -p sites/tsconfig.json` checks a site's links against every page; and `.sanoma/content.ts`, the types of [`content`](/sites/content/).
- `appViteConfig({ repo })` is the build's Vite config; `appViteConfig()` is this package's own (its `vite.config.ts`), the same pipeline with no sites. `appSources()` gives the app's `src` and `tsconfig.site.json` by real path.

### Local development

`startApp(config, { dev: { repo } })` serves the app and the repo's sites from Vite's dev server instead of a build, behind the same `/healthz` and login: `appDevServer(repo, http)` from `sanoma/app/build` is the build's Vite config (`appViteConfig({ repo })`, so the route generator's options are the build's) in middleware mode, with hot updates over the app's own HTTP server, and Start's server entry imported for each request and handed the same context.

On the server, Vite compiles the app's source and `sanoma` (whose `sanoma/site` and `sanoma/ui` are that source), and leaves the runtime to Node, the copy `startApp`'s context holds.

An edit to a site or to the app's source shows without a reload, a Tailwind class in a new file under `sites/` is in the app's stylesheet and each site's own, and a new site folder is live once it has a route file; a change to `sites/__virtual.ts` itself needs a restart. It writes the sites' generated files and Vite's cache under `.sanoma/app/`, and no build. It listens on this machine only: the hot updates' websocket does not pass the login, so `startApp` refuses `dev` with any other `host`.

`dev.onFileChange`, when given, is called with each file the dev server's watcher sees added, changed or removed (`sanoma` writes `.sanoma/api.ts` again on a change to what the config is read from).

A company repo is an ES module package (`"type": "module"`, as `sanoma init` writes it): Vite names the server entry `server.mjs` otherwise.
