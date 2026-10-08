# @sanoma/app

A web UI and a JSON API for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces: it renders from `describeConfig(config)`, the config's ledger store and Postgres, and never parses workflow code. It runs no workflows itself.

It is a [TanStack Start](https://tanstack.com/start) app (React, TanStack Router, Query and Form), built into the package and served by `startApp` from Node.

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

`startApp` checks the config first and throws what the worker would refuse. The worker and the app share the config's Postgres (`databaseUrl`, else `SANOMA_DATABASE_URL`) and its ledger store. Give the config a `jsonlLedger` so the app, in its own process, can read what the worker records; a `memoryLedger` is visible only in the process that wrote it. Without `port`, the app takes any free port and reports it in `app.url`. `app.close()` stops it.

## Screens

- **Runs**: recent runs with their workflow, status, who started them, when, pending approvals and any error. Refreshes every 2 seconds while the page is visible.
- **Run**: one run's ledger as a timeline (the start, each operation call with its effect, the policy's decision, duration, input and output, each approval asked, decided or ignored, and how it ended) beside its approvals, each with the operations it lets through (badged by effect), and Approve and Reject with an optional note while the run can still read a decision.
- **Inbox**: every pending approval, newest first, with what it lets through and the same controls. Refreshes every 5 seconds.
- **Start**: a form built from the workflow's input schema: text, date and time, numbers, yes/no, choices, lists with Add and Remove, and objects one level deep; anything else is entered as JSON. Optional fields left empty are left out, so the schema's defaults apply. The server checks the input with the workflow's schema and its complaints appear on the fields they name.
- **Workflows**: each workflow's operations with their effects, its built-ins and its input; whether a policy is configured, and its version; the config's version.

The header switches between light, dark and the system's theme; the browser remembers the choice. The screens are built with [shadcn/ui](https://ui.shadcn.com) components (`src/components/ui`, from `components.json`) on Tailwind CSS.

## No authentication

This is a local tool. There is no login. The page asks "Who are you?" once, keeps the answer in the browser, and sends it with every change. Anyone who can reach the app can start runs and decide approvals as any name they type; the approver check only compares names. The app listens on 127.0.0.1 unless you pass another `host`. While it listens on this machine only, it refuses every request (page, API, server function or static file) whose `Host` names anything but this machine, so another site cannot reach it through DNS rebinding. Do not expose it to a network you do not trust.

Reads are open. Anyone who can reach the app sees every run, its ledger (each operation's input and output included) and its approvals, through the page and `GET /api/*`; nothing asks who they are. On this machine, the Host check above is the only protection.

### Hosted

A hosted deployment puts its own authentication in front of the whole app (a reverse proxy or an identity-aware proxy), since the app checks no one on a read. It also replaces the header with its own login through `resolveActor`, which turns each request into the person acting (`{ id, groups? }`), or `undefined` to refuse a change:

```ts
await startApp(config, { resolveActor: async (request) => sessionUser(request) });
```

With its own `resolveActor`, the page never asks for a name: it shows who the deployment says you are. An approval addressed to a group (`{ group: "finance" }`) can be decided only by a principal whose `groups` lists it, and the default header carries a name only, so group approvals need a `resolveActor` that supplies `groups`. A `resolveActor` that throws fails the change with a 500 saying "Could not tell who you are", logged with the request.

A 500's `error` is the raw message of what failed, which can name internal details such as a database host. The app does not hide them yet; a deployment that must not show them filters 500 bodies in its proxy.

## HTTP API

The page uses server functions; scripts (and later Slack or access-request callbacks) use this JSON API. Requests that change something name the actor in the `x-sanoma-actor` header (URI-encoded), or are refused with 400.

- `GET /api/config`: `describeConfig(config)`, including `version` and `policy`.
- `GET /api/runs?limit=50&status=waiting`: recent runs, newest first (`limit` 1 to 500), only those with `status` when given (`queued`, `running`, `waiting`, `finished`, `failed` or `cancelled`).
- `GET /api/runs/:id`: `{ run, ledger, ledgerError?, approvals }`.
- `POST /api/runs` with `{ "workflow": name, "input": {...} }`: 201 `{ runId }`.
- `POST /api/runs/:id/approvals/:approvalId` with `{ "decision": "approve" | "reject", "note"?: string }`: the approval's state, 200 once the run has read the decision. When the run has not read it within 5 seconds (no worker is running, say), 202 with the approval still `pending`: the decision stays queued and the run reads it when it next runs. The page says so and keeps the dialog open.

Errors are `{ error, code?, issues?, approver? }`. Branch on `code`, never on `error`: `invalid_input` is 400 (with `issues` when the input or the body does not match its schema), `not_approver` 403 (with `approver`), `run_not_found` and `no_pending_approval` 404, `already_decided` and `run_ended` (the run has finished, failed or been cancelled, so it reads no decision) 409. An unknown workflow is 404 with `invalid_input` and an issue at `workflow`; a body without `content-type: application/json` is 415; anything unexpected is 500.

## Developing

In the repo, `pnpm --filter @sanoma/app build` builds the app (`vite build` into `dist/client` and `dist/server`, and the `startApp` entry). `startApp` serves that build even when run from source, so rebuild after changing anything under `src/` except `index.ts`.

Status: early (0.x). The API may change between minor versions.

License: Apache-2.0.
