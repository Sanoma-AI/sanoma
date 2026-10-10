# @sanoma/app

A web UI and a JSON API for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces: it renders from `describeConfig(config)`, the config's ledger store and Postgres. The only workflow code it reads is each workflow's `run`, once at start, to draw its outline. It runs no workflows itself.

It is a [TanStack Start](https://tanstack.com/start) app (React, TanStack Router, Query and Form), built into the package and served by `startApp` from Node.

## Usage

```sh
npm install @sanoma/app @sanoma/workflows
```

Run it beside the worker, from the same config:

```ts
import { startApp } from "@sanoma/app";
import config from "./sanoma.config.ts";

const app = await startApp(config, { port: 4321 });
console.log(app.url); // http://127.0.0.1:4321
```

`startApp` checks the config first and throws what the worker would refuse. The worker and the app share the config's Postgres (`databaseUrl`, else `SANOMA_DATABASE_URL`) and its ledger store. Give the config a `jsonlLedger` so the app, in its own process, can read what the worker records; a `memoryLedger` is visible only in the process that wrote it. A run that has started but has no records in the app's ledger says so on its page, since the likeliest cause is an app reading another ledger than the worker's (a `jsonlLedger` directory relative to another working directory). Without `port`, the app takes any free port and reports it in `app.url`. `app.close()` stops it.

## Screens

- **Runs**: recent runs with their workflow, status, who started them, when, pending approvals and any error. Refreshes every 2 seconds while the page is visible.
- **Run**: one run as a graph (see [Run graph](#run-graph)), and its ledger as a timeline (the start, each operation call with its effect, the policy's decision, duration, input and output, each approval asked, decided or ignored, and how it ended) beside its approvals, each with the operations it lets through (badged by effect), and Approve and Reject with an optional note while the run can still read a decision.
- **Inbox**: every pending approval, newest first, with what it lets through and the same controls. Refreshes every 5 seconds.
- **Start**: a form built from the workflow's input schema: text, date and time, numbers, yes/no, choices, lists with Add and Remove, and objects one level deep; anything else is entered as JSON. Optional fields left empty are left out, so the schema's defaults apply. The server checks the input with the workflow's schema and its complaints appear on the fields they name.
- **Workflows**: each workflow's outline (see [Outline](#outline)), its operations with their effects, its built-ins and its input; whether a policy is configured, and its version; the config's version.
- **Resources**: each resource the data files declare (its name, type and vendor, and the declaration it comes from, which opens in its file below the table, marked), with the latest drift check's verdict: clean, drifted (with each field that differs, as declared and as the vendor holds it, open at first), gone, error (and why), or not checked. **Run drift** starts the built-in `drift` workflow on the data files as they are then, and the page refreshes every 2 seconds until it ends; it links to the run, and to the run of the report it shows. Problems in the data files show above the table, each at its file, line and column, since their resources are left out. The `drift` workflow is not on the Start page: Workflows sends you here to run it.
- **Connectors**: each vendor the config's operations are from, by title: its logo and id, links to its connector's npm package and source (from `defineConnector`'s `package` and `homepage`, when it gives them), its operations with their effects, and the workflows that may call them.

The screens share one shell: a sidebar with the six pages (Inbox badged with how many approvals are pending) and, above the page, the sidebar's toggle and a breadcrumb (the page, or Runs and the run's workflow). The toggle, or Ctrl+B (⌘B on a Mac), folds the sidebar down to its icons, and the sidebar opens as you left it on your next visit (it keeps that in a cookie); on a phone the sidebar is a sheet over the page that closes as you follow a link. The sidebar's footer is a menu with who you are (and Change name, under the default resolver) and the theme: light, dark or the system's, which the browser remembers. The screens are built with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`, from `components.json`) on Tailwind CSS.

### Run graph

The run page draws the run as a graph above its ledger, left to right: the start, each operation call (its effect, the policy's decision, its duration or error), each sleep, each approval the workflow asked for, and how the run ended, or a dashed end while it has not. An approval the policy asked for sits on the call it holds. The calls of one `ctx.all` branch out side by side and join again after it. Each node's colour says how it went: done, failed or denied, waiting on a person or a sleep, or running. The graph is read from the ledger alone, so it shows what happened, not what the workflow may still do, and it redraws as the page polls. Clicking a node scrolls to its record in the ledger. A sleep is labelled with the time it ends, in UTC, as the ledger shows times, so the server and every browser draw the same text. It is drawn with [React Flow](https://reactflow.dev) in the browser only; the server renders a placeholder of the same size, the graph's code loads, once, only on the pages that draw a graph (this one and Workflows), starting as the page's data loads, and each graph is drawn when it first scrolls near the screen. A graph pans sideways with the scroll wheel or a drag; its zoom control (React Flow's zoom slider, in the bottom left corner) zooms out and in, shows the zoom (a click sets it back to 100%), and fits the whole graph in view.

A `ctx.all` draws as one lane per member, top to bottom in member order, between the step before it and the step after: in a run that posts to three vendors at once, sleeps, then reads two results at once, the graph shows three lanes, the sleep, then two lanes, each lane coloured as its call went (a call the policy holds waits in its own lane). While a `ctx.all` is the last thing the run has done and the run goes on, each member that has recorded nothing yet has a dashed "not started" lane. Members that never ran, after one failed, or once the run has moved past the group or ended, have no lane.

### Outline

Each workflow card on the Workflows page draws the workflow's shape before it runs, from the `outline` that `describeConfig` (`@sanoma/workflows/describe`) reads once per workflow when `startApp` starts. It is the run graph's drawing without colours: the operations (with their effects), approvals and sleeps the body of `run` calls, a `ctx.all` as lanes, a loop or a `ctx.all` over a list as a box labelled "repeats" or "for each", and an `if` or `switch` as a diamond that splits into one lane per case, plus a lane marked "otherwise" when the run can go by without any of them (an `if` without `else`, say). It is a reading of the source, labelled so: "Read from the body of run; the functions it calls are not shown, even those defined in it". When the source cannot be read the card says why instead.

## No authentication

This is a local tool. There is no login. The page asks "Who are you?" once, keeps the answer in the browser, and sends it with every change. Anyone who can reach the app can start runs and decide approvals as any name they type; the approver check only compares names. The app listens on 127.0.0.1 unless you pass another `host`. While it listens on this machine only, it refuses every request (page, API, server function or static file) whose `Host` names anything but this machine, so another site cannot reach it through DNS rebinding. Do not expose it to a network you do not trust.

Reads are open. Anyone who can reach the app sees every run, its ledger (each operation's input and output included) and its approvals, through the page and `GET /api/*`; nothing asks who they are. On this machine, the Host check above is the only protection.

### Hosted

A hosted deployment puts its own authentication in front of the whole app (a reverse proxy or an identity-aware proxy), since the app checks no one on a read. It also replaces the header with its own login through `resolveActor`, which turns each request into the person acting (`{ id, groups? }`), or `undefined` to refuse a change:

```ts
await startApp(config, { resolveActor: async (request) => sessionUser(request) });
```

With its own `resolveActor`, the page never asks for a name: it shows who the deployment says you are. An approval addressed to a group (`{ group: "finance" }`) can be decided only by a principal whose `groups` lists it, and the default header carries a name only, so group approvals need a `resolveActor` that supplies `groups`. The app calls `resolveActor` only for a request that needs to know who is asking, once per request. One that throws fails the change with a 500, logged with the request as "Could not tell who you are: " and the resolver's message; the sidebar's footer says "Could not tell who you are" and asks again every 10 seconds.

## HTTP API

The page uses server functions; scripts (and later Slack or access-request callbacks) use this JSON API. Requests that change something name the actor in the `x-sanoma-actor` header (URI-encoded), or are refused with 400.

- `GET /api/config`: `describeConfig(config)`, including `version` and `policy`, with each workflow's `outline`, and the resources the data files declare with the data files' `problems`. A data file with a problem does not stop the app: `startApp` warns about it on the console and leaves its resources out.
- `GET /api/runs?limit=50&status=waiting`: recent runs, newest first (`limit` 1 to 500), only those with `status` when given (`queued`, `running`, `waiting`, `finished`, `failed` or `cancelled`).
- `GET /api/runs/:id`: `{ run, ledger, ledgerError?, approvals }`. `ledgerError` says why `ledger` is empty: the ledger could not be read, or it has no records for a run that has started.
- `POST /api/runs` with `{ "workflow": name, "input": {...} }`: 201 `{ runId }`.
- `GET /api/resources`: `{ resources, problems, canDrift, latest, lastReport }`: the resources the data files declare and their problems (as `GET /api/config` has them), whether the config has the built-in `drift` workflow, the latest drift run (any status) and `{ runId, report }`, the `DriftReport` of the latest that finished; `null` before there is one.
- `POST /api/resources/drift`: starts a drift check of the data files as they are now, as the actor: 201 `{ runId }`; 400 `invalid_input` when the connectors declare no resource types.
- `POST /api/runs/:id/approvals/:approvalId` with `{ "decision": "approve" | "reject", "note"?: string }`: the approval's state, 200 once the run has read the decision. When the run has not read it within 5 seconds (no worker is running, say), 202 with the approval still `pending`: the decision stays queued and the run reads it when it next runs. The page closes the dialog and shows the decision as queued, with Approve and Reject disabled for that approval, until the run's status changes.

Errors are `{ error, code?, issues?, approver? }`. Branch on `code`, never on `error`: `invalid_input` is 400 (with `issues` when the input or the body does not match its schema), `not_approver` 403 (with `approver`), `run_not_found` and `no_pending_approval` 404, `already_decided` and `run_ended` (the run has finished, failed or been cancelled, so it reads no decision) 409. An unknown workflow is 404 with `invalid_input` and an issue at `workflow`; a body without `content-type: application/json` is 415; anything unexpected is 500 with `error` "Something went wrong" (and its `code`, when it has one). A 500 never carries the message of what failed, which can name internal details such as a database host: the app logs it with the request instead.

## Developing

In the repo, `pnpm --filter @sanoma/app build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` entry). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: Apache-2.0.
