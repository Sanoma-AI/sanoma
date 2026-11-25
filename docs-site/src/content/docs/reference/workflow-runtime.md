---
title: "Workflow configuration and runtime"
description: "Look up trigger behavior, configuration discovery, ledger records, and client calls."
sidebar:
  order: 6
---

The configuration, trigger, and client entries below describe how Sanoma starts and records a workflow. The `refund` examples use the [shop connector and workflow](/building-connectors/define-a-connector/#a-connector-and-a-workflow).

## Triggers

A workflow's `trigger` is `"manual"` or `{ schedule, timezone? }` (`Trigger`): a five-field cron expression in an IANA time zone, UTC without one. The worker of the app's latest version keeps DBOS's schedules to the config's, one per scheduled workflow named `<app>/<workflow>` on the app's queue, deleting those no longer declared; a tick missed while the instance was stopped fires once when it starts again.

Each tick is a run of the workflow under its own name (run id `sched-<app>/<workflow>-<time>`, its `run.started` record's `scheduledFor`), started by the runtime's `schedule` agent with the input `{}`, so `defineWorkflow` refuses a schedule for a workflow whose input refuses `{}`. The policy decides the start as it would a manual start by that agent (`workflow:<name>`, the principal `schedule`, in `agents`): a deny fails the run with its reason, and so does a hold, since a schedule waits for no approval.

`nextFire(schedule, timezone, from)` is when a cron fires next, as DBOS's scheduler finds it, and `nextScheduledFire(resolved, from)` the earliest over a config's workflows. A scheduled workflow can still be started by hand.

## The config

A config names the connectors, and the workflows when no launcher finds them (`sanoma` imports every file of `workflows/` and of each [app's](/start/apps/#apps), so a company's config lists none; one it lists is kept, once):

```ts
import { defineConfig } from "sanoma/workflows";

export default defineConfig({
  workflows: [refund],
  connectors: [shop],
});
```

## What the config finds by convention

That is the whole config; the rest is convention, from its `root` (`defineConfig`'s call site's directory, or `root` where that is not the source's, as in a bundle). Three conventions give what a config no longer says:

- **The app's name** is the `name` in `<root>/package.json`, kept whole (`@acme/ops`), when that file exists and names one; otherwise, and for a config with no root, it is `"sanoma"`. Only the root's own file counts, never one above it, so a parent project's name never becomes the app's; a `package.json` that is not JSON is refused, naming it. The name scopes the app's runs, queues and versions in its database.
- **The [scenarios](/testing/scenarios/)** are the `.feature` files of `<root>/scenarios/` and of each [app's](/start/apps/#apps) `scenarios/`, named by their path from the root (`scenarios/x.feature`, `apps/crm/scenarios/y.feature`); without any such directory the config has none.
- **The [policy](/policies/policies/)** is `<root>/policies/**/*.cedar` and each [app's](/start/apps/#apps) `policies/**/*.cedar`, decided as the [people](/policies/people/) the data files declare; without any, every call and start is allowed (`allowAll`).

`name` is the company's name as people read it (the app, the agent and a sign-in code's mail name the company by it), else the app name made readable (`sanoma-ops` is "Sanoma Ops"). The app name, `appName`, is `<root>/package.json`'s `name`, else `sanoma`, and scopes the company's runs in the database, so `name` may change any time. The [data files](/workflows/resources/#data-files) are `resources/` in the root and in each [app](/start/apps/#apps).

`ledger` and `databaseUrl` configure persistence; `secrets`, `connections` and `connectionRules` configure [credential storage and account identity](/workflows/credentials/). `drivers`, `fakes`, `appName`, `scenarios` and `policy` are typed `never` on `SanomaConfig`, each deprecated with where it went, so the compiler and the editor say so; an untyped config that still names `drivers` or `fakes` is refused at run time rather than run live on what it no longer reads, and one that names `policy` rather than run allowing everything.

A worker looks for queued runs every second, DBOS's default; `SANOMA_QUEUE_POLL_MS` sets that in milliseconds, as this repository's tests do.

The audit record goes to the ledger, by default `postgresLedger(databaseUrl)` on the config's database (see [Ledger](/workflows/ledger/)); `ledger: jsonlLedger(dir)` keeps it in files instead, and `memoryLedger()` in this process only, for tests.

`resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`, for every run, [sandbox runs](/testing/scenarios/) included), the operations by id, the driver each vendor's connector attaches, made once for the resolution (`driversByVendor`, in `connectors` order, and their functions by operation id, `drivers`), the makers of their fakes (`fakes`, by vendor), the scenarios directory, the policy (`policy`, the policies it is made from as `policies`, and what is wrong in them as `policyProblems`), and the config's `ledger` when it gives one; it opens nothing and reads no file outside the root: its `package.json`, whether `scenarios/` is a directory, and the policies with the people files.

It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver (`` `shop.order.refund` has no driver: the connector package must attach one ``), two different drivers or fakes for one vendor, two workflows with one name, a `ledger` that is not a store, a `drivers`, `fakes` or `policy` an untyped config still names.

`startWorker`, `SanomaClient.connect` and `describeConfig` all call it, so they fail the same way. It adds the built-in [`drift`](/workflows/resources/#drift) and [`apply`](/workflows/resources/#apply) workflows when the connectors declare resource types, and [`call`](/workflows/direct-calls/) when an operation may be called directly. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

## What the ledger records

For the events, fields, and errors recorded for a run, see [Ledger records](/workflows/ledger/#what-the-ledger-records).

## People and the client

People are `Principal`s: `{ id, groups?, onBehalfOf? }`. A run is started as one and a decision is sent as one, by id: the groups are the [people files'](/policies/people/), never the caller's, and an `onBehalfOf` is kept only for a declared agent allowed to act for that person (`agentActing`).

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice" } });
const approval = await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }); // status: "approved"
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`workflow` is a definition or the name of one in the config's `workflows` (`client.start("refund", …)`); a name the config does not have is refused with `invalid_input`, naming the ones it has. `startedBy` is required. `start(workflow, input, { startedBy, runId })` with a `runId` makes a retried start idempotent: an id that exists returns that run when the workflow, the input (as JSON) and `startedBy` match, and is refused with `invalid_input`, naming what differs, when they do not.

Of two starts racing with one new id, the first stands and the second is answered the same way. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `approval_withdrawn`: the approval a call or step waited on was [withdrawn](/workflows/approvals/), `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`, `run_ended`, `run_running`: `client.result` timed out with the run still going, `approval_pending`: a [direct call](/workflows/direct-calls/) is held, `not_admitted`: the data files declare people and not this principal's id) and `data`.

Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

## Running it

`startWorker(config, { logLevel })` executes workflows and recovers interrupted runs. Use `SanomaClient` to start or list runs, record a decision, or read the ledger.

For a UI, `describeConfig(config)` from `sanoma/workflows/describe` returns plain JSON with the config version and these entries:

- **Workflows and operations.** Each workflow includes its input as JSON Schema, its callable operations, its [outline](/workflows/your-own-ui/#outline), and any problems beside its `file`. Each operation includes its effect and contract. Inputs describe what the caller sends (`io: "input"`), and outputs describe parsed values (`io: "output"`).
- **Vendors.** The `vendors` map is keyed by vendor ID. An entry includes the title, logo as a `data:image/svg+xml` URL, package, homepage, and whether the connector supplies a fake.
- **Resources.** `resourceTypes` describes the [resource types](/workflows/resources/). The `resources`, `orphans`, and `problems` entries give the declarations, their bindings, orphaned lockfile entries, and diagnostics. See [Data files](/workflows/resources/#data-files).

The worker, the client and the app find Postgres at the config's `databaseUrl`, else the `SANOMA_DATABASE_URL` environment variable, else `postgresql://postgres:dbos@localhost:5433/sanoma`, the database `pnpm db:up` starts from this repo's docker compose file. The `sanoma` launcher always sets `SANOMA_DATABASE_URL`: when none is named it starts the company's own Postgres ([sanoma's Postgres](/hosting/postgres/)). Set one of the first two anywhere but on your own machine.

## Package dependencies

The `sanoma` package includes `sanoma/workflows`, `sanoma/app`, `zod`, `typescript`, `@types/node`, and `oxlint`. Its optional `@sanoma-ai/postgres-<platform>` dependency supplies [local Postgres](/hosting/postgres/).

A TypeScript project that imports `sanoma` gets Node’s types through its declarations. This works with npm, pnpm, or a linked install. If the repo also lists `@types/node`, match Sanoma’s major version or deduplicate the declarations to avoid conflicts. A separate project that imports nothing from `sanoma`, such as a scripts directory with its own tsconfig, must list `@types/node` and set `"types": ["node"]` itself.

## Output for the starter alone

A run's output is in its `run.finished` record, which everyone who reads the ledger sees. A field that is for the run's starter alone, such as a short-lived link or a token, is named in `opaque`, with the same paths as an operation's: a dotted path goes into a field, and into each item of a list it holds.

```ts
export default defineWorkflow({
  name: "box-open",
  trigger: "manual",
  input: z.object({ name: z.string() }),
  uses: [boxes.box.open],
  opaque: ["url"],
  run: async (ctx, { name }) => ctx.boxes.box.open({ name }), // { id, url, expiresAt }
});
```

The operation the field comes from declares it `opaque` too (`box.open` here), or the value sits in that operation's `op.called` record.

`<api>.result` answers the run's output as it is to the run's starter: the same principal, and for an agent, acting for the same person. An opaque field is only readable by a starter with an identity: a signed-in person or visitor, an API token, or an agent acting for a person; every visitor who is not signed in is one `anonymous`, so their own run's field is hidden from them too. Every other read shows each `opaque` field as `"<url>"`: `.result` asked by anyone else, `.latest`, `.ledger`, the app's run page and `/mcp`'s `wait_run`. `defineWorkflow` refuses a path that is not names joined by dots. A workflow declares no output schema, so `sanoma check` cannot tell a path the output never has: such a path hides nothing. The real output stays in the database's record of the run, which `client.result(runId)` reads for code on the server.

## One run at a time per person

`concurrency: "one per person"` makes the runs of a workflow for one person run one after another, in the order they were started. Another person's runs never wait for them. Use it when a run reads something and then acts on it, such as counting a company's boxes before it opens another, so two runs started together cannot both act on the same count.

```ts
export default defineWorkflow({
  name: "box-open",
  trigger: "manual",
  input: z.object({ name: z.string() }),
  uses: [boxes.box.list, boxes.box.open],
  concurrency: "one per person",
  run: async (ctx, { name }) => {
    const open = await ctx.boxes.box.list({});
    if (open.length >= 3) throw new Error("Three boxes are open already");
    return ctx.boxes.box.open({ name });
  },
});
```

The person is the one the run is for: `ctx.startedBy.onBehalfOf` when an agent starts it for someone, such as the chat acting for a person, and otherwise `ctx.startedBy.id`, which is a person, a signed-in visitor, an API token (`token:<id>`, each token its own), or an agent acting for no one. So a run a person starts in the app and a run the chat starts for them wait for each other. The key is never a field of the input. A start by `anonymous`, which every visitor who is not signed in shares, is refused with `policy_denied`, since one visitor's run waiting on an approval would hold up every other visitor's.

A run waiting for an earlier one is `queued`. Its page in the app says which run it waits for, and over `/mcp`, `get_run` names that run in `after` and `wait_run` answers `{ runId, status: "queued", after }`. The engine's queue keeps the order, in Postgres. A run that is waiting on an approval or a sleep keeps its place, and so does a start the policy holds for an approval, until it is decided and the run ends. The next run starts once the one ahead ends in any way: finished, failed or cancelled. Cancelling is cooperative: a cancelled run stops at its next step, so the next run can start while the cancelled one is still inside a step. A worker that stops while it is idle and wakes again, or restarts on the same code, picks up where it left off: the earlier run resumes first, and the ones behind it keep waiting.

Each version of the company's code keeps its own order, since the version is part of the place. A run left unfinished on old code is never run by a worker of new code (company runs are not carried across versions), so when a worker of a new version starts, it cancels each such run that holds a person's place, as it does an apply started on other code, and logs which. What that frees depends on how runs were queued:

- Locally, the app queues runs with no version, and the latest worker runs them. A run that was queued behind the cancelled one starts on the new code.
- On a deployed instance, the app queues each run for its own version. A run still queued for the old version when the new one starts is never started, as with any run queued for an older version; the person's new runs on the new version do not wait for it.

A sandbox run calls fakes and does not wait. `defineWorkflow` refuses `concurrency` on a scheduled workflow, since its runs are started by the runtime's `schedule` agent, and refuses any value but `"one per person"`.
