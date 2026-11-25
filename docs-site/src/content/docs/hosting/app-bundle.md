---
title: The app bundle
description: "What a Cloudflare Worker serves from an app bundle, which bindings it uses, and which tasks need a checkout."
sidebar:
  order: 7
---

The app can answer requests without reading company files. It reads an `AppSnapshot` containing the description, people, Cedar policies, source text for the Code view, scenarios, and fields and published entries from `content/`. The snapshot also includes the repository remote with credentials removed, `infra.ts`, lockfile bindings, facts for a host that derives its settings, and the `applicationVersion` used to enqueue runs.

`startApp` creates the snapshot with `appSnapshot(config, { source })`. When a source file changes, `liveSnapshot` refreshes it.

## The bundle

`buildAppBundle(repo, { config, domains })` from `sanoma/app/bundle` builds the same app, every route and site, for Cloudflare's workerd (`nodejs_compat`), with the snapshot baked in, into an `AppBundle`: its main module and modules (base64), its assets with Cloudflare's hash and size, the compatibility date and flags, and the pages of each public site on one of `domains` that show everyone the same content, prerendered into the assets: every page but one whose file, a layout above it, or a site file either imports (directly or through others, statically or by `import()`) calls `api` or renders a `RunForm`, or imports code the build does not read (outside the site's folder, an `import()` not written out, `import.meta.glob`, a package's `#import`, a path from the root): the rule is `SitePage.calls`.

A login on the site does not matter: on its domain, the server's render never reads the visitor, whom `useActor()` asks for once the page is in the browser, so a prerendered page shows no visitor's own header.

### Worker bindings

The main module exports `fetch(request, env, ctx, host?)` (`AppBundleModule`). When a request queues a run, `host.startNow()` starts the worker.

| Binding | How the Worker uses it |
| --- | --- |
| `env.DATABASE` | Connects through Hyperdrive or another binding with a `connectionString`. |
| `SANOMA_HOSTNAME` | Identifies the app host and its [agent address](/start/agents-over-mcp/). Requests for a host other than the app, a site, or the configured [router](/start/agents-over-mcp/#a-router-one-mcp-for-many-companies) receive 404. Without an app hostname, other nonsite hosts serve the app and the Cloudflare binding `SANOMA_HOST_URL` supplies its agent address. With neither value, agents cannot sign in. |
| `SANOMA_AGENT_URL`, `SANOMA_COMPANY`, `SANOMA_ROUTER_SECRET` | For a company behind a router, identify the router’s `/mcp` endpoint, the company, and its company-specific secret. For a Worker serving the router, the secret is the router’s master secret. A missing secret or router hostname that collides with the app or a site logs an error and prevents the router from serving. |
| `SANOMA_DOMAINS`, `SANOMA_SIGNING_KEY`, `SANOMA_SECRETS_KEY`, `ASSETS` | Supply site domains, signing and encryption keys, and static assets. |

A `cloudflare.host` supplies router bindings from its `agents` declaration and from the config’s `router`. See [router configuration on Cloudflare](/start/agents-over-mcp/#on-cloudflare).

### Request handling

The Worker serves a prerendered page for its domain from `ASSETS`. The first request that needs the app loads it. Each request gets its own client. Cedar loads on the first policy decision and uses the policies that `sanoma` checked at build time. The bundle carries only the modules its main module reaches. The bundle's config is the one `sanoma` loads: the config file's, with each workflow file's workflow and `resources/data.ts`'s collections joined to it.

Each module's `import.meta.url` is its file's URL, as on Node (workerd has none), and what a connector's `vendorInfo(import.meta.url)` reads of its package is read at build.

## What the Worker cannot run

- **Not on the Worker:** what reads the checkout or runs a child process. Adopt, a form's Save, going live, connecting a repository and a chat's turn are runs of the built-ins `adopt`, `patch`, `go-live`, `go-live-host`, `go-live-cloud`, `connect-existing` and `chat`, which a worker given the app's steps runs (`sanoma serve` and `sanoma worker` give them theirs); on a worker without them, the run fails saying so.

  The staff's sign-in and each site's login run on the Worker as on Node, each request on its own pool; the Worker's bindings give `SANOMA_SIGNING_KEY` for their keys and, for GitHub sign-in, `SANOMA_GITHUB_CLIENT_ID` and `SANOMA_GITHUB_CLIENT_SECRET` (both or neither). A login that cannot start (the key unset) is logged, and its pages answer 503.
- **Refused:** a site's file, a file of `operations/` (the root's or an app's, whose body answers a page's direct call), or the app's own, that imports what workerd does not have (`node:fs`, `node:child_process`, …): the build throws `NodeOnlyImport`, naming the file and what it imports, which `sanoma check` reports.

  And a bundle that cannot answer: the build runs it on workerd and asks its `/healthz`, which loads the app as a first request does, so a module that throws as it is evaluated (one reading a file, say) fails the build with `<file>:<line> throws as the Cloudflare Worker evaluates it`, the file from the repo, or from `node_modules` for a package's, by the bundle's source map.
