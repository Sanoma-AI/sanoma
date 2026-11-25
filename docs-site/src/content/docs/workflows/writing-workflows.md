---
title: Writing workflows
description: "It is a part of sanoma, whose bin runs the worker and the app over a repo's sanoma.config.ts and whose root entry re-exports what a workflow imports from sanoma/workflows; startWorker and startApp rem."
sidebar:
  order: 1
---

```sh
npm install sanoma
```

It is a part of [`sanoma`](https://www.npmjs.com/package/sanoma), whose bin runs the worker and the app over a repo's `sanoma.config.ts` and whose root entry re-exports what a workflow imports from `sanoma/workflows`; `startWorker` and `startApp` remain for a custom host.

## A connector and a workflow

A connector declares a vendor's operations: their inputs, outputs and effect. A workflow lists the operations it `uses`, and its `ctx` exposes those and nothing else. The company's [own operations](/workflows/your-own-operations/) (`defineOperation`, a file of `operations/`) are listed the same way and called as `ctx.operations.<name>.run`.

```ts
import { defineConnector, defineWorkflow } from "sanoma/workflows";
import { z } from "zod";

const shop = defineConnector("shop", {
  order: {
    get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ total: z.number() }) },
    refund: { effect: "money", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
});

export default defineWorkflow({
  name: "refund",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [shop.order.get, shop.order.refund, "approval"],
  run: async (ctx, { id }) => {
    const order = await ctx.shop.order.get({ id });
    // Covers the refund below, so the policy lets it through without asking again.
    await ctx.approval(`Refund ${order.total}`, { approver: "finance-lead", covers: [shop.order.refund] });
    return ctx.shop.order.refund({ id });
  },
});
```

## Triggers

A workflow's `trigger` is `"manual"` or `{ schedule, timezone? }` (`Trigger`): a five-field cron expression in an IANA time zone, UTC without one. The worker of the app's latest version keeps DBOS's schedules to the config's, one per scheduled workflow named `<app>/<workflow>` on the app's queue, deleting those no longer declared; a tick missed while the instance was stopped fires once when it starts again. Each tick is a run of the workflow under its own name (run id `sched-<app>/<workflow>-<time>`, its `run.started` record's `scheduledFor`), started by the runtime's `schedule` agent with the input `{}`, so `defineWorkflow` refuses a schedule for a workflow whose input refuses `{}`. The policy decides the start as it would a manual start by that agent (`workflow:<name>`, the principal `schedule`, in `agents`): a deny fails the run with its reason, and so does a hold, since a schedule waits for no approval. `nextFire(schedule, timezone, from)` is when a cron fires next, as DBOS's scheduler finds it, and `nextScheduledFire(resolved, from)` the earliest over a config's workflows. A scheduled workflow can still be started by hand.

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

`<api>.result` answers the run's output as it is to the run's starter: the same principal, and for an agent, acting for the same person. Every other read shows each `opaque` field as `"<url>"`: `.result` asked by anyone else, `.latest`, `.ledger`, the app's run page and `/mcp`'s `wait_run`. `defineWorkflow` refuses a path that is not names joined by dots. A workflow declares no output schema, so `sanoma check` cannot tell a path the output never has: such a path hides nothing. The real output stays in the database's record of the run, which `client.result(runId)` reads for code on the server.

## Describing the vendor

A third argument says who the vendor is, so the app can show it: `defineConnector("shop", specs, { title: "Shop", logo: { svg, dark }, package, homepage })`. `logo.svg` is the vendor's mark as inline SVG markup, one `<svg>…</svg>` element (`defineConnector` refuses anything else, such as a file path or a URL), and `logo.dark` its variant for dark backgrounds, if it has one. The app shows a logo before each of the vendor's operations, in graphs and lists, and only ever as an image (`<img>` with a `data:` URL), where an SVG's scripts and external references never run or load. A vendor with no logo is shown by its operations' ids alone, as before. `package` is the connector's npm package name (`"@sanoma-ai/connector-resend"`), which the app's Connectors page links to on npm.

`homepage` is the connector package's `homepage` from its package.json: where its code and README are, as an https URL (`defineConnector` refuses anything else); the Connectors page links to it as the connector's source. A vendor whose operations are split over several connectors is described by the first connector's info, its package and homepage as well as its title and logo. A connector package writes all of this once, in its package.json, and passes `vendorInfo(import.meta.url)` as the third argument (the nearest package.json is read): it reads the `"sanoma": { "title", "logo", "logoDark"?, "agent"? }` field, whose logos are SVG files in the package (relative `.svg` paths, listed in `files`), and the package's `name` and `homepage`. With the `sanoma-connector` keyword, the same field is how the app lists the package on npm before it is installed.

## Drivers and fakes

A [driver](/workflows/connectors/) implements the operations and holds the credentials, and a [fake](/testing/fakes/) stands in for the vendor in [sandbox runs](/testing/scenarios/). A connector package attaches both to the connector it exports, with `withSetup` (and its [steps](/testing/scenarios/#steps-a-connector-ships) for Gherkin tests, as `steps`), so a config names the connector alone:

```ts
// The connector package's root, such as @acme/connector-shop.
export const shop = withSetup(defineConnector("shop", specs, info), {
  driver: shopDriver, // made once per resolved config
  fake: fakeShop, // made once per sandbox run: each has its own
});
```

`withSetup` lays what it is given over what the connector already carries, and keeps it on the connector's vendor record, so a spread copy of the connector keeps it too. A config that needs a driver made otherwise (another bridge, other options) swaps the driver and keeps the fake: `withSetup(github, { driver: () => githubDriver({ bridge }) })`. It is for connector packages and configs, not for workflows, which the lint does not let import it. Both are optional: a connector without a driver declares its operations and implements none, so a workflow using one is refused; a connector without a fake has none for sandbox runs, which the app's connector page says.

## Setup halves

A connector that keeps tables on the company's database (a login's) attaches how to make them, as `prepare`: `withSetup(connector, { prepare: async (databaseUrl) => … })`, a `DatabasePreparation` the worker runs at its start, after the runtime's own tables, with the database's direct URL (never a pooler's: an advisory lock is one connection's); idempotent, and safe for two workers at once. The app never makes a connector's tables, since on a host it may run where it must not migrate: a login opened before the worker prepared them refuses. `startWorker`'s `prepare` option adds preparations no config names, as the `sanoma` bin adds the staff login's.

A connector that signs visitors in to a public site attaches a login half too, as `login`: `withSetup(connector, { login: (context) => half })`. The app calls it once per public site whose `site.ts` names the connector (`defineSite({ public: true, login: "<vendor>" })`), when it starts, with a `LoginContext` (`database()`, the client's pool, the app's one on Node and the request's own on a Worker, so a half keeps an instance per pool and nothing else across requests; a key of its own derived from `SANOMA_SIGNING_KEY` to sign its cookies with, a vendor's secrets, the site's origins, `sendCode(email, code)` when the config names a `login.sender`, and `social`, the company's GitHub App's OAuth client when the app is given it), on the tables its `prepare` made.

The `LoginHalf` it makes (see its type) answers the provider's stable subject for a request, with the email and the GitHub login when it verified them, never a principal: the app makes the visitor's principal from it, so a connector cannot set a visitor's groups. A visitor's address, for rate limits, is the `CLIENT_IP_HEADER` header the app sets, never `X-Forwarded-For`. One vendor's connectors attach one `login`, as for a driver. [`sanoma/better-auth`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/better-auth/README.md) is one, email and password (and an email code, with a sender) on the company's database; it also exports `betterAuthStaffLogin`, the staff sign-in the app uses on a host (`LoginContext.staff`: who is declared, the GitHub client, and where a sign-in is recorded). The app makes it as it starts and sends it every request to the site's own host ([public sites](/sites/public-sites/)).

A model connector attaches a model half, as `model`: `withSetup(connector, { model: (context) => provider })`, an AI SDK provider (`ProviderV4` from `@ai-sdk/provider`) with the vendor's adapter as the transport. The app makes it for its model registry, once per resolved config and client (again after one that throws), where its models are `<vendor>/<model-id>`; it answers `languageModel("default")` with the connector's own default. Its `ModelContext` gives it the secrets as a login's does (the selected store and explicit bindings), which it reads when a model is called; its driver declares the key in `env`, with no operations if it needs none. One vendor's connectors attach one `model`. [`@sanoma-ai/connector-anthropic`](https://www.npmjs.com/package/@sanoma-ai/connector-anthropic) is one.

A git host's connector attaches a remote half, as `remote`: `withSetup(connector, { remote: () => half })`, a `RemoteHalf` made once per resolved config and kept in `ResolvedConfig.remotes` by vendor; `remoteFor(remotes, url)` finds the one whose `matches` reads a clone URL, with the repository. `open(repo, { secrets })` gives a `SourceHost`: the repository's pull requests (find, open, squash-merge at a head, close), the `sanoma` commit status, and `enforcement(base)`, whether the host refuses a change to the branch that is not a merge (`HostEnforcement`); its `token(prefer)` is what a push signs in with. `webhook(request, { secrets })` verifies a delivery and says what happened (`RemoteEvent`: a branch pushed, a pull request closed); `owners({ secrets })` lists the accounts the company's app on the host is installed on, and `permissions({ secrets })` what that app may do, as the host lists it (both optional, undefined or empty without the app's keys). It reads its tokens through `secrets` when called, as a model half does. One vendor's connectors attach one `remote`. [`@sanoma-ai/connector-github`](https://www.npmjs.com/package/@sanoma-ai/connector-github#remote-half) is one.

A connector whose vendor makes a coding agent attaches it, as `agent`: `withSetup(connector, { agent: { own, onKey } })`, a `CodingAgent` the app's chat runs. Who the agent is is its package.json's, as the vendor's is: `"sanoma": { …, "agent": { "id", "title", "mark"?, "markDark"? } }`, its mark SVG files in the package (the logo's when it names none) (`VendorInfo.agent`, which `defineConnector` checks: an id of lowercase letters, digits and dashes, never `loop` or `acp-…`; marks as logos are). `own` (`OwnAgent`) runs it on a person's own plan over the Agent Client Protocol: the packages installed for it on first use (each pinned, without install scripts), a `setup` script to run once installed, its ACP bin and arguments, how the person signs in from the chat (`AgentSignIn`), and the `hosts` it reaches from the box (its sign-in, its model's API).

`onKey` (`KeyAgent`) runs it on the company's key through the AI SDK's `HarnessAgent`: its adapter, loaded when first used (`harness(auth, home)`), whether it takes the model qualified and runs a bridge, the `hosts` what it runs in the box reaches, and the model it runs on by contract, `model`, the vendor of the model connector whose `<vendor>/default` and key (the variables that connector's driver declares) the app passes it, never a dependency on that connector; `baseUrl` names the variable the app passes on from its environment for the model's endpoint. `ResolvedConfig.agents` holds them by the agent's id (`InstalledAgent`: who it is, its vendor and its parts; two vendors may not give one id, and a connector with an `agent` whose package.json names none is refused), and `describeConfig` lists them as `agents` (`AgentEntry`: id, vendor, title, mark as `data:` URLs, `own`, `once` when its own plan's sign-in is a command run once on the person's computer, and `onKey.model`). The chat names one `acp-<id>` on a person's plan and `<id>` on the company's key. [`@sanoma-ai/connector-anthropic`](https://www.npmjs.com/package/@sanoma-ai/connector-anthropic) gives Claude Code, `-github` Copilot, `-openai` Codex, `-opencode` OpenCode and `-pi` Pi.

## Webhooks

`SanomaClient.follow(event)` starts the built-in `follow` workflow on what a webhook says happened (the app's `POST /webhooks/<vendor>` calls it for each event it verified), as the runtime's agent `host-check`, with the run id `follow:<sha256 of the event>`: one run per event, however often it is delivered, and `start` refuses a `follow` under another id or actor. The worker runs it over its repository (`WorkerOptions.source`): an event of another repository, or on a worker with none, is ignored (the run's output says why). A push to `main` fast-forwards the checkout, then starts apply on the declared hosts the lockfile binds (`ResolvedConfig.hosts()`; a host not bound yet waits for going live, whose apply makes it) as `host-check`, as the run `deploy:<head>`, so a merge made outside Sanoma deploys too: nothing without a host, nor while a change is merging or deploying, which applies `main` itself; when the checkout cannot follow `main`, the run fails, saying why, and deploys nothing.

A push to `draft/<id>` while the change of `id` is open brings the host's commits into the draft (`Source.follow` on its branch, a fast-forward) and tells the change `commits`; a closed pull request of `draft/<id>` tells it `merged` (with the merge commit) or `closed`. The change run checks a merge or a close on the host before it believes it. A delivery repeated does nothing more: the run id, a draft already at the head, and the event's key (`changeEvent`'s `key`, an idempotency key of its message) see to it. `host-check` is not the Publish approval's approver, so it withdraws nothing: a change waiting on Publish reads the event when Publish is decided.

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

`name` is the company's name as people read it (the app, the agent and a sign-in code's mail name the company by it), else the app name made readable (`sanoma-ops` is "Sanoma Ops"). The app name, `appName`, is `<root>/package.json`'s `name`, else `sanoma`, and scopes the company's runs in the database, so `name` may change any time. The [data files](/workflows/resources/#data-files) are `resources/` in the root and in each [app](/start/apps/#apps). `ledger` and `databaseUrl` configure persistence; `secrets`, `connections` and `connectionRules` configure [credential storage and account identity](/workflows/credentials/). `drivers`, `fakes`, `appName`, `scenarios` and `policy` are typed `never` on `SanomaConfig`, each deprecated with where it went, so the compiler and the editor say so; an untyped config that still names `drivers` or `fakes` is refused at run time rather than run live on what it no longer reads, and one that names `policy` rather than run allowing everything. A worker looks for queued runs every second, DBOS's default; `SANOMA_QUEUE_POLL_MS` sets that in milliseconds, as this repository's tests do.

The audit record goes to the ledger, by default `postgresLedger(databaseUrl)` on the config's database (see [Ledger](/workflows/ledger/)); `ledger: jsonlLedger(dir)` keeps it in files instead, and `memoryLedger()` in this process only, for tests. `resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`, for every run, [sandbox runs](/testing/scenarios/) included), the operations by id, the driver each vendor's connector attaches, made once for the resolution (`driversByVendor`, in `connectors` order, and their functions by operation id, `drivers`), the makers of their fakes (`fakes`, by vendor), the scenarios directory, the policy (`policy`, the policies it is made from as `policies`, and what is wrong in them as `policyProblems`), and the config's `ledger` when it gives one; it opens nothing and reads no file outside the root: its `package.json`, whether `scenarios/` is a directory, and the policies with the people files.

It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver (`` `shop.order.refund` has no driver: the connector package must attach one ``), two different drivers or fakes for one vendor, two workflows with one name, a `ledger` that is not a store, a `drivers`, `fakes` or `policy` an untyped config still names. `startWorker`, `SanomaClient.connect` and `describeConfig` all call it, so they fail the same way. It adds the built-in [`drift`](/workflows/resources/#drift) and [`apply`](/workflows/resources/#apply) workflows when the connectors declare resource types, and [`call`](/workflows/direct-calls/) when an operation may be called directly. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

## Targets

An operation names the instance it acts on with `target`, a function of its parsed input, so a policy can decide per post or per order rather than per operation (its Cedar resource, `Sanoma::Target::"order/ord_1"`). TypeScript types its input `any` there, so annotate it to have it checked:

```ts
const shop = defineConnector("shop", {
  order: {
    refund: {
      effect: "money",
      input: z.object({ id: z.string() }),
      output,
      target: ({ id }: { id: string }) => `order/${id}`,
    },
  },
});
```

## What the ledger records

The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested, decided and withdrawn (`approval.withdrawn` with its `reason`; a policy's hold names the call it holds by its `op` and `opSeq`, the `seq` that call's own record has), each message an approval ignored (`approval.refused`: sent by someone who may not decide it, or not a decision), each sleep (`sleep.started` with `until`, when it ends in ms since the epoch: the time asked for, or for a duration, the record's `at` plus the duration, as the runtime saw it; written for a time already past too), and how the run ended, in a JSONL file per run. A decision is recorded with its `reasons` (the ids of the policies behind it) and, with Cedar policies, their `policyVersion`, a hash of their text.

Every record carries `v: 1`, the `app` and the `actor`, and one written inside a `ctx.all` member its `group` (see [Built-ins](/workflows/built-ins/)); each call's record (`op.called`, `approval.requested`, `sleep.started`) carries its step's `name` (see [Step names](/workflows/built-ins/#step-names)); an error is recorded as `{ code?, name, message }`, with `retryable` when the error says, the vendor's `status` and `vendorCode` only from a `DriverError`, and `data` only from the runtime's own errors (the operation, the approval, the input's issues), so an HTTP client's error that escapes a driver does not put the vendor's reply in the ledger. A ledger store's failed append is tried again up to three times; a store throws an error with `retryable: false` for a failure that would only repeat. When a call's record still cannot be written after the vendor replied, the call fails with "`<op id>` succeeded, but the ledger could not record it" and the run makes no further calls (`run_ended`), so a workflow that catches the failure cannot repeat the side effect unrecorded.

## People and the client

People are `Principal`s: `{ id, groups?, onBehalfOf? }`. A run is started as one and a decision is sent as one, by id: the groups are the [people files'](/policies/people/), never the caller's, and an `onBehalfOf` is kept only for a declared agent allowed to act for that person (`agentActing`).

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice" } });
const approval = await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }); // status: "approved"
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`workflow` is a definition or the name of one in the config's `workflows` (`client.start("refund", …)`); a name the config does not have is refused with `invalid_input`, naming the ones it has. `startedBy` is required. `start(workflow, input, { startedBy, runId })` with a `runId` makes a retried start idempotent: an id that exists returns that run when the workflow, the input (as JSON) and `startedBy` match, and is refused with `invalid_input`, naming what differs, when they do not. Of two starts racing with one new id, the first stands and the second is answered the same way. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `approval_withdrawn`: the approval a call or step waited on was [withdrawn](/workflows/approvals/), `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`, `run_ended`, `run_running`: `client.result` timed out with the run still going, `approval_pending`: a [direct call](/workflows/direct-calls/) is held, `not_admitted`: the data files declare people and not this principal's id) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

## Running it

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)`, from `sanoma/workflows/describe`, returns the same config as plain JSON (its version, each workflow's input as JSON Schema, the operations it may call and its [outline](/workflows/your-own-ui/#outline), each operation's effect and contract: its input as a caller sends it, `io: "input"`, and its output as parsed, `io: "output"`), each vendor's title, logo, package and homepage and whether its connector attaches a fake (`vendors`, by vendor id, the logo as `data:image/svg+xml` URLs), the resource types (`resourceTypes`, see [Resources](/workflows/resources/)), and the resources the data files declare, each with its binding, the lockfile's orphans and what is wrong in them (`resources`, `orphans` and `problems`, see [Data files](/workflows/resources/#data-files); a workflow's file's problems are on its entry, beside its `file` and `outline`), which is what a UI renders from.

The worker, the client and the app find Postgres at the config's `databaseUrl`, else the `SANOMA_DATABASE_URL` environment variable, else `postgresql://postgres:dbos@localhost:5433/sanoma`, the database `pnpm db:up` starts from this repo's docker compose file. The `sanoma` launcher always sets `SANOMA_DATABASE_URL`: when none is named it starts the company's own Postgres ([sanoma's Postgres](/hosting/postgres/)). Set one of the first two anywhere but on your own machine.
