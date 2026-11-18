---
title: Install in a repository
description: "sanoma brings sanoma/workflows, sanoma/app, zod, typescript, @types/node and oxlint with it."
sidebar:
  order: 2
---

```sh
npm install sanoma @sanoma-ai/connector-ghost
```

`sanoma` brings `sanoma/workflows`, `sanoma/app`, `zod`, `typescript`, `@types/node` and `oxlint` with it: a repo installs nothing else but its connectors. Node's types reach the repo's `tsc` through `sanoma` itself (its declarations reference them, resolved from where it is installed), under pnpm, npm or a link alike, so a repo lists no `@types/node`. A repo that lists its own of another major gets two sets of Node's declarations, which conflict: keep one, by matching sanoma's or letting the installer dedupe them. A tsconfig project that imports nothing from `sanoma` (a scripts directory with a tsconfig of its own, say) gets none this way: it sets `"types": ["node"]` and lists `@types/node` itself. Node 26 or later. Nothing else: the [Postgres](/hosting/postgres/) it starts comes with it, as `@sanoma-ai/postgres-<platform>`, an optional dependency.

A repo holds `sanoma.config.ts` at its root, with `workflows/`, optional `policies/` (Cedar files), `resources/` (data files, the people among them) and `scenarios/` (feature files) beside it, optional `apps/` (see [Apps](/start/apps/)), and a `tsconfig.json` that extends the one this package ships:

```json
{
  "extends": "sanoma/tsconfig.json",
  "include": [
    "sanoma.config.ts",
    "workflows",
    "operations",
    "resources",
    "apps/*/app.ts",
    "apps/*/workflows",
    "apps/*/operations",
    "apps/*/resources"
  ]
}
```

```ts
// sanoma.config.ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { defineConfig } from "sanoma";

export default defineConfig({ connectors: [ghost] });
```

Each connector carries its driver and its fake, so the config names neither, and every command that loads the config finds the workflows: each `.ts` file under `workflows/` and each app's `apps/<app>/workflows/` (but `*.test.ts`, `*.spec.ts` and `*.d.ts`) is imported, and its default export, which must be a workflow (`defineWorkflow`), is added to the config's `workflows`; a file without one is a helper the workflows import. A config may still list workflows (`workflows: [publish]`): one it lists is kept, once. The rest is the repo's layout: the company's name as people read it is the config's `name` (`name: "Maple Street Studio"`), else the app's name, `package.json`'s `name`, which scopes its runs, the scenarios are `scenarios/`, the data files `resources/` and the policies `policies/**/*.cedar`, beside `sanoma.config.ts` (see [People and policies](/policies/people-and-policies/)). The ledger is Postgres's, on the config's database; `ledger: jsonlLedger(dir)` keeps it in files instead.

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

A workflow imports from `sanoma` what the lint lets it (`defineOperation`, `defineWorkflow`, `mayDecide`, `errorCode`, `z`, `sanoma`, the runtime's own operations, and types); `zod` itself and `sanoma/workflows` are accepted too. The config file imports `defineConfig` (and a ledger store, `jsonlLedger`, `memoryLedger` or `postgresLedger`, when it names one) from `sanoma`, and its connectors from their packages. A site, `sites/<name>/` (pages the app serves under `/sites/<name>/`; `defineSite({ public: true, login })` in its `site.ts` marks one for visitors, served at the root of its own host too, and `locales` its languages), imports `defineSite`, the app's route APIs (`Link`, `Outlet`, `useNavigate`, …) and `api`, which calls the company's operations and workflows as the person on the page ([calling operations and workflows](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/app/README.md#calling-operations-and-workflows)), from `sanoma/site` with the rest of what talks to the app (`RunForm`, a workflow's start form, and `useActor`, who is signed in), how its pages look (the app's components, presentational only) from `sanoma/ui`, Sanoma's claims about connectors, apps and solutions (`claims`, `appTier`, …) from `sanoma/claims`, and `createFileRoute` from `@tanstack/react-router`; the [app's README](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/app/README.md#a-sites-imports) has the whole list. A data file under `resources/` imports `secret` and `sanoma` (the people types) from `sanoma/resources`, and `resources/data.ts`, the company's [collections](/workflows/collections/), imports `collection` from `sanoma/data` and nothing else:

```ts
// resources/data.ts
import { collection } from "sanoma/data";

export const outbound = collection({
  name: "outbound",
  key: "company",
  fields: { company: "text", stage: { enum: ["researched", "contacted", "won", "lost"] }, owner: "person" },
});
```

Every command that loads the config imports `resources/data.ts` too, and each app's, when there is one, and adds its collections to the config's `collections` (each of its exports must be one), so `sanoma.config.ts` does not list them. A workflow that calls `ctx.data.outbound.get` imports `outbound` from `../resources/data.ts` to name it in `uses`: the one file outside `workflows/` the lint lets it import.
