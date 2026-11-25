---
title: Apps
description: "Organize workflows, collections, policies, and sites by app, or bring an app in from another repository."
sidebar:
  order: 3
---

An app groups related code under `apps/<name>/`. It can contain the same directories as the company root, including `workflows/`, `operations/`, `resources/`, `policies/`, `scenarios/`, and `sites/`. For an app merged from another repo, its `app.ts` names the source.

```ts
// apps/crm/app.ts
import { defineApp } from "sanoma";

export default defineApp({ source: "https://github.com/acme/crm" });
```

The folder name scopes an app’s declarations. Two apps can each have a `customers` collection. For example, `apps/crm/resources/data.ts`'s is `crm.customers` (`ctx.data.crm.customers.get(…)`, `api.data.crm.customers.list()`, the Cedar action `data.crm.customers.save`), `apps/crm/workflows/follow-up.ts`'s `follow-up` is `crm.follow-up` (`api.crmFollowUp`, `When crm.follow-up runs`), and `apps/crm/sites/pipeline/` is served at `/sites/crm/pipeline`.

An app is taken and updated by the chat's agent as a git merge into its draft (`take_app`, `update_app`; see [the app's screens](/start/the-app/)); an update reads the source `main`'s `app.ts` names, so an app taken in a draft is updated once that take is published. The company's own workflows, at the root, may import any app's `resources/data.ts` to join them; `sanoma check` warns of an import from one app's files into another's.

See [Apps](#apps).

## Apps

A company's apps are the folders of `apps/`, each holding what the root does: `workflows/`, `operations/`, `resources/` (its `data.ts` too), `policies/`, `scenarios/` and `sites/`.

An app is merged into the repo from a source repository, or made there; its `app.ts` says which, `export default defineApp({ source: "https://github.com/acme/crm" })` (`defineApp({})` for the company's own), which `readApps(root)` loads (`AppEntry`, `{ name, dir, source?, at? }`, by name; `defineApp` served by the [loader](/workflows/resources/#data-files)): a default export that is not `defineApp({ source })` with `source` a string, or an `app.ts` that throws, is a problem.

A folder's name is the app's (`APP_NAME`: a lowercase letter, then lowercase letters and digits); `describeConfig` refuses another as a problem, and lists the apps as `apps`.

What an app's folder declares is named with the folder, from where its file is (`appOfFile`: the nearest directory with a `sanoma.config.ts`, then `apps/<app>/`), never written: a collection `customers` in `apps/crm/resources/data.ts` is `crm.customers`, its operations `data.crm.customers.get` and so on, a workflow `follow-up` in `apps/crm/workflows/` is `crm.follow-up`, and an operation `score` in `apps/crm/operations/` is `operations.crm.score.run` (`ctx.operations.crm.score.run(…)`), each with `app: "crm"`; what the root declares keeps its name.

So two apps may declare one name. A file is an app's while the nearest directory above it with a `sanoma.config.ts` is the company's root (an app may keep its own `package.json`; a `node_modules` ends the search). A workflow calls an app's collection as `ctx.data.crm.customers.get(…)`, and a site as `api.data.crm.customers.list()`; an app's workflow is `api.crmFollowUp` (`apiNameOf`), and its Cedar action `workflow:crm.follow-up`.

A site in `apps/crm/sites/pipeline/` is `crm/pipeline`, at `/sites/crm/pipeline`. `describeConfig`'s workflows, collections and sites carry their `app`.

### Shared people and cross-app imports

The people are the company's: an app's data files declare none (`readPeople` refuses one, naming its file). A workflow may import the root's `resources/data.ts` and any app's. A relative import from one app's files into another's folder is a warning (`crossAppImports(root, apps)`, from `sanoma/workflows/describe`, which `sanoma check` prints), since a company may take one app without the other: reach the other through `ctx` or `api` instead. A collection or site at the root named as an app is a problem: `api.data.<app>` and `/sites/<app>/` are the app's.

### Taking and updating an app

Taking or updating an app merges Git history into a company draft through `Source` (the package supplies `localGitSource`).

| Method | Behavior |
| --- | --- |
| `draft.take({ url, ref?, folder?, author })` | Fetches a public company repo over HTTPS and merges its history in one merge commit. If the source has several `apps/<folder>/` directories, supply `folder`. |
| `draft.update({ folder, author })` | Merges new default-branch commits from the URL in the published `app.ts`. |
| `source.behind(folder)` | Fetches and counts those new commits. |

Update and behind checks require shared history with the checkout. `appSourceOf` reports an invalid or throwing `app.ts` and identifies apps with no source as the company’s own. Sanoma reads `app.ts` from `main`. Publish a newly taken app before updating it.

Either merge takes `apps/<folder>/` (a take, the source's folder whole) and `package.json` (its connectors, both sides kept); every other file stays the company's, as does a file one side deleted, since the source's root is the starter's. Both return an `AppMerge` (`{ folder, revision, merged, conflicts }`): a line both sides changed is committed with git's markers (diff3: ours, the base, theirs) and its file named in `conflicts`, so the draft's checks fail until the agent resolves it.

An update needs the take's merge commit in the history: a draft that takes an app is merged into `main` as a merge, not squashed.
