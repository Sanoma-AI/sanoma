# @sanoma/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. An oxlint config and `lintWorkflow` guard workflow and policy code against accidental non-determinism and accidental ways around the policy. They are lint, not a sandbox: code written to get around them can.

```sh
npm install @sanoma/workflows zod
```

A connector declares a vendor's operations: their inputs, outputs and effect. A workflow lists the operations it `uses`, and its `ctx` exposes those and nothing else.

```ts
import { defineConnector, defineWorkflow } from "@sanoma/workflows";
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

Drivers implement the operations and hold the credentials. A policy is checked before every operation call, and a ledger records what happened.

```ts
import { allow, approve, approvedFor, defineConfig, definePolicy, jsonlLedger } from "@sanoma/workflows";

const policy = definePolicy(
  ({ op, effect, run }) => {
    if (effect !== "money") return allow();
    // Approved by finance-lead for this operation: not any approval, and not one a workflow
    // addressed to someone else.
    return approvedFor(run.approvals, op.id, "finance-lead") ? allow() : approve("finance-lead");
  },
  { version: "2026-10-07" },
);

export default defineConfig({
  workflows: [refund],
  connectors: [shop],
  drivers,
  policy,
  ledger: jsonlLedger(".sanoma/ledger"),
  appName: "acme",
});
```

A config must name its policy and its ledger. `policy: allowAll` allows every operation call, and says so. `ledger: jsonlLedger(dir)` keeps the audit record in files the app and other processes read; `memoryLedger()` keeps it in this process only, for tests. `resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`), and the operations and drivers by id. It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver, two workflows with one name, no policy, no ledger. `startWorker`, `describeConfig` and `SanomaClient.connect` all call it, so they fail the same way. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

A policy returns `allow()`, `deny(reason)` (the run fails) or `approve(who)` (the run waits for that person, or for anyone in `{ group }`; see [Approvals](#approvals)). `allow(reasons)` and `deny(reason, reasons)` may add a list of reasons for whoever reads the ledger. The policy must decide the same way on every replay: no clock, randomness or network. What it sees is plain data, so a test can build one by hand:

```ts
interface PolicyCall {
  op: { id: string; vendor: string; resource: string; name: string; effect: Effect }; // no schemas
  effect: Effect; // the same as op.effect
  target?: string; // the instance the call acts on, when the operation declares `target`
  input: unknown; // checked against the operation's schema
  actor: Principal; // who started the run
  run: { id: string; workflow: string; approvals: readonly ApprovalState[] };
}
```

An operation names the instance it acts on with `target`, a function of its parsed input, so a policy can decide per post or per order rather than per operation:

```ts
const shop = defineConnector("shop", {
  order: {
    refund: { effect: "money", input: z.object({ id: z.string() }), output, target: ({ id }) => `order/${id}` },
  },
});
```

A policy's answer is checked; anything else (`{ kind: "approve" }` with no approver, say) fails the run with a message naming the operation. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided, each message an approval ignored (`approval.refused`: sent by someone who may not decide it, or not a decision), and how the run ended, in a JSONL file per run. A decision is recorded with its `reasons` and, for a policy from `definePolicy(fn, { version })`, its `policyVersion`. Every record carries `v: 1`, the `app` and the `actor`; an error is recorded as `{ code?, name, message }`, with the vendor's `status`, `vendorCode` and `retryable` when a `DriverError` gave them, and the `data` of one of the runtime's errors (the operation, the approval, the input's issues). A ledger store's failed append is tried again up to three times; a store throws an error with `retryable: false` for a failure that would only repeat.

People are `Principal`s: `{ id, groups? }`. A run is started as one and a decision is sent as one:

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice", groups: ["support"] } });
const approval = await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }); // status: "approved"
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`startedBy` is required. `start(workflow, input, { startedBy, runId })` with a `runId` makes a retried start idempotent: an id that exists returns that run when the workflow, the input (as JSON) and `startedBy` match, and is refused with `invalid_input`, naming what differs, when they do not. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`, `run_ended`) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)` returns the same config as plain JSON (its version, each workflow's input as JSON Schema and the operations it may call, each operation's effect and contract), which is what a UI renders from.

### Approvals

An approval comes from the workflow (`ctx.approval(title, { approver, covers?, links?, details? })`) or from the policy holding a call (`approve(approver, { title?, covers? })`). Each is in `run.approvals` with its `status`, so a later policy call can see it.

`covers` says which operations an approval stands for, as op ids in the approval's state. A policy hold covers the operation it held, plus any `covers` the policy adds; a workflow's approval covers the operations it names, or none. The idiomatic policy check is `approvedFor(run.approvals, op.id, approver)`: approved, covering this operation, and addressed to the approver the policy would name. The last part matters: a workflow can request an approval covering any operation from anyone it names, so a check on `covers` alone would let a workflow launder a sign-off through its own `ctx.approval`. Covers name operations, not inputs: an approval that covers `shop.order.refund` covers every later refund call in the run. A policy that needs one approval per call compares `a.input` too.

The approver is a person's id (`"finance-lead"`), or `{ group: "finance" }` for anyone whose principal lists that group in `groups`. A group's name is not a person: `{ id: "finance" }` is not in the group `finance`. `mayDecide(approval, principal)` is the check the run and the client both use. A policy hold's default title is `<op id> needs <approver>`, the approver shown as `group finance` for a group.

`client.decide(runId, { decision, by, note? }, approvalId?, { timeoutSeconds? })` refuses without sending when the approval is decided already (`already_decided`), when the run has finished, failed or been cancelled (`run_ended`: no run would read the decision), when there is nothing pending (`no_pending_approval`, `run_not_found`) or when `by` may not decide (`not_approver`, naming the approver or group). Otherwise it sends the decision and waits for the run to read it, then returns the approval as decided: the run publishes it on the event `decisionEventOf(approvalId)`. If another decision reached the run first (someone else's, or another of yours), it throws `already_decided` with who decided and how: each message carries an `id` (a new one unless `message.id` is given), and the approval records the one it was decided with as `decidedWith`. The id is also the send's idempotency key, scoped to the approval, so a retried send queues one message. If the run does not read the decision within `timeoutSeconds` (30 by default), for instance because no worker is running, it returns the approval still `pending`; the decision stays queued and the run reads it when it next runs. The run checks the sender again and records anything it refuses as `approval.refused`.

### Calls run one at a time

A run's ctx calls run one at a time, in program order. Inside `Promise.all`, each call waits for the one before it to settle, so two calls a policy holds for approval are asked for one after the other. DBOS matches a replayed call to its recorded result by the order calls reach it, so calls left to race would replay out of step. A call that fails rejects its caller; the calls after it still run. Write calls one after another, as the workflow means them.

`ctx.sleep({ until })` takes an ISO 8601 date-time with an offset (`2026-10-07T09:00:00Z`) or epoch milliseconds, and a time already past does not wait; `ctx.sleep({ minutes: 5 })` takes a duration from `ms`, `seconds`, `minutes`, `hours` and `days`, none negative. A request it can't read fails the run with `invalid_input`, as does an operation input its schema refuses.

### Drivers

A driver implements a connector's operations with `defineDriver(connector, { resource: { name: (input, call) => … } })`, typed by the connector's schemas. `call` carries `idempotencyKey`, the same on every retry and replay of one call: pass it to the vendor (or dedupe on it) so a crash between the vendor's reply and the checkpoint does not repeat the side effect. A driver reads its credentials when it is called, never from the config.

When the vendor says no, throw a `DriverError(message, { retryable, status?, vendorCode? })`. An operation declared `idempotent` is tried up to three times (after 1 and 2 seconds) unless the error says `retryable: false` or the reply fails the output schema; any other operation is tried once. When the tries run out, the run fails with the last try's error, so `errorCode(err)` is `"driver_failed"` and the ledger records the vendor's message, not a wrapper.

### Secrets

Never put a secret in a workflow's input or an operation's input or output. They are persisted verbatim: DBOS keeps every step's input and output in Postgres, the ledger records each call's input and output, an approval a policy asks for carries the held call's input, and the app shows all of it to anyone who can reach it. A driver reads its credentials when it is called (from the environment or a secret store), and an operation that creates a secret (an API key, a password reset link) returns a reference to where it is stored, not the secret.

### Versions

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Versioning is automatic: the version is a hash of each workflow's name, the source of its `run` function, its operations and its input schema, which is DBOS's own scheme applied to the workflow code rather than to the runtime's registration wrapper (DBOS would otherwise see one identical function for every workflow and never change). The hash cannot see functions `run` calls that live elsewhere, op schemas, drivers or the policy: edit those with no run in flight, or restart on the old code first. To name a version instead (a git commit, say), set DBOS's `DBOS__APPVERSION` environment variable; it is prefixed with the app name the same way. A new version becomes the app's latest when it first starts, and runs queued without a version go to the latest; a worker started on an older version (a rollback) warns instead, unless started with `{ promote: true }`. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. On a local database, `pnpm db:down && pnpm db:up` resets it.

## Keeping workflows replay-safe

A run is replayed after a restart by calling the function again and reading each step's result back, so workflows and policies must do the same thing every time, and must reach vendors only through `ctx` so the policy sees every call. Two checks guard against getting that wrong by accident, on files under `workflows/` and `policies/`. They are not a sandbox: they read the source, and code written to get around them can.

oxlint, with the rules this package ships in `oxlint.json`, refuses the clock (`Date`, `performance`), randomness (`Math.random`, `crypto`), the network (`fetch`, `WebSocket`), timers, `process`, `globalThis`, and imports of `@sanoma/testing`, `@sanoma/app`, `@sanoma/connector-*/fake` and `@sanoma/connector-*/driver`. From `@sanoma/workflows` it allows only `defineWorkflow`, `definePolicy`, `allow`, `deny`, `approve`, `approvedFor`, `allowAll`, `mayDecide`, `errorCode`, `DriverError` and types: the rest could start runs or approve the run's own approvals (`SanomaClient`, `startWorker`), forge the audit record (`jsonlLedger`, `memoryLedger`: a store keeps the first record per id) or read credentials. Each message names the `ctx` replacement. Extend it from your `.oxlintrc.json` (oxlint resolves `extends` as a path, not a package name; the `workflows/**` and `policies/**` globs resolve against your config):

```json
{
  "extends": ["./node_modules/@sanoma/workflows/oxlint.json"]
}
```

`lintWorkflow` from `@sanoma/workflows/lint` checks the same names from `@sanoma/workflows`, and what oxlint can't express: imports come only from `@sanoma/workflows`, a `@sanoma/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` or `policies/` directory (so not `../sanoma.config.ts`, which holds the drivers); no namespace import of `@sanoma/workflows`; no dynamic `import()`; and no `instanceof` against `DriverError`, `SanomaError`, `PolicyDeniedError` or `RejectedError`. On a replay DBOS rethrows a serialized copy of an error, which is no instance of its class, so a branch on `instanceof` would go another way than the first time and the run's steps would fall out of step. Read `errorCode(err)` instead. Run it over those directories in a test:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow } from "@sanoma/workflows/lint";
import { expect, it } from "vitest";

const files = ["workflows", "policies"].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f)),
);

it.each(files)("%s has no problems", (file) => {
  expect(lintWorkflow(readFileSync(file, "utf8"), file)).toEqual([]);
});
```

`@sanoma/workflows/lint` is a separate entry so the runtime never loads its parser.

Status: early (0.x). The API may change between minor versions.

TODO: redact fields a schema marks `.meta({ sensitive: true })` from the ledger, the approvals event and DBOS's step records, so a secret passed by mistake is not kept.

License: Apache-2.0.
