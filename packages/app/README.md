# @sanoma/app

A small web UI for a [Sanoma](https://github.com/Sanoma-AI/sanoma) config: the runs, each run's ledger and approvals, a form to start a workflow, and what each workflow may call. It reads the same `sanoma.config.ts` your worker runs, so it shows exactly what the worker enforces. It renders from `describeConfig(config)`, the config's ledger store and Postgres, and never parses workflow code.

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

The worker and the app share the config's Postgres (`databaseUrl`, else `SANOMA_DATABASE_URL`) and its ledger store. Give the config a `jsonlLedger` so the app, in its own process, can read what the worker records; an in-memory ledger is visible only in the process that wrote it. Without `port`, the app takes any free port and reports it in `app.url`. `app.close()` stops it.

The page has five screens:

- **Runs**: recent runs with their workflow, status, who started them, when, pending approvals and any error.
- **Run**: one run's ledger as a timeline (the start, each operation call with its effect, the policy's decision, duration, input and output, each approval asked, decided or ignored, and how it ended) beside its approvals, with Approve and Reject.
- **Inbox**: every pending approval across recent runs, newest first.
- **Start**: a form built from the workflow's input schema. Optional fields left empty are left out, so the schema's defaults apply.
- **Workflows**: each workflow's operations with their effects, its built-ins, its input, and whether a policy is configured.

## No authentication

This is a local tool. There is no login. The page asks "Who are you?" once, keeps the answer in the browser, and sends it with every request. Anyone who can reach the app can start runs and decide approvals as any name they type; the approver check only compares names. The app listens on 127.0.0.1 unless you pass another `host`, and refuses requests addressed to any host name but this machine's. Do not expose it to a network you do not trust.

## HTTP API

The page uses a JSON API that scripts can use too. Requests that change something name the actor in the `x-sanoma-actor` header.

- `GET /api/config`: `describeConfig(config)`.
- `GET /api/runs?limit=50`: recent runs.
- `GET /api/runs/:id`: `{ run, ledger, approvals }`, or 404.
- `POST /api/runs` with `{ "workflow": name, "input": {...} }`: `{ runId }`, or 400 with `issues` when the input does not match the schema.
- `POST /api/runs/:id/approvals/:approvalId` with `{ "decision": "approve" | "reject", "note"?: string }`: the approval, or 403 when the actor is not the approver.

Status: early (0.x). The API may change between minor versions.

License: Apache-2.0.
