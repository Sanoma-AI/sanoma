# @sanoma/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. An oxlint config and `lintWorkflow` check that workflow code is safe to replay and cannot get around the policy.

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
    await ctx.approval(`Refund ${order.total}`, { approver: "finance-lead" });
    return ctx.shop.order.refund({ id });
  },
});
```

Drivers implement the operations and hold the credentials. A policy is checked before every operation call, and a ledger records what happened.

```ts
import { allow, approve, defineConfig, definePolicy, jsonlLedger } from "@sanoma/workflows";

const policy = definePolicy(
  ({ op, effect, run }) => {
    if (effect !== "money") return allow();
    // Approved for this operation, not just any approval by that person.
    const approved = run.approvals.some((a) => a.requestedBy === "policy" && a.op === op.id && a.status === "approved");
    return approved ? allow() : approve("finance-lead");
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

A config must name its policy. `policy: allowAll` allows every operation call, and says so. `resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`), and the operations and drivers by id. It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver, two workflows with one name, no policy. `startWorker`, `describeConfig` and `SanomaClient.connect` all call it, so they fail the same way. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

A policy returns `allow()`, `deny(reason)` (the run fails) or `approve(who)` (the run waits for that person). `allow(reasons)` and `deny(reason, reasons)` may add a list of reasons for whoever reads the ledger. The policy must decide the same way on every replay: no clock, randomness or network. What it sees is plain data, so a test can build one by hand:

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

A policy's answer is checked; anything else (`{ kind: "approve" }` with no approver, say) fails the run with a message naming the operation. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided, each message an approval ignored (`approval.refused`: sent by someone other than the approver, or not a decision), and how the run ended, in a JSONL file per run. A decision is recorded with its `reasons` and, for a policy from `definePolicy(fn, { version })`, its `policyVersion`. Every record carries `v: 1`, the `app` and the `actor`; an error is recorded as `{ code?, name, message }`. A ledger store's failed append is tried again up to three times; a store throws an error with `retryable: false` for a failure that would only repeat.

People are `Principal`s: `{ id, groups? }`. A run is started as one and a decision is sent as one:

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice", groups: ["support"] } });
await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } });
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`startedBy` is required. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)` returns the same config as plain JSON (its version, each workflow's input as JSON Schema and the operations it may call, each operation's effect and contract), which is what a UI renders from.

### Calls run one at a time

A run's ctx calls run one at a time, in program order. Inside `Promise.all`, each call waits for the one before it to settle, so two calls a policy holds for approval are asked for one after the other. DBOS matches a replayed call to its recorded result by the order calls reach it, so calls left to race would replay out of step. A call that fails rejects its caller; the calls after it still run. Write calls one after another, as the workflow means them.

`ctx.sleep({ until })` takes an ISO 8601 date-time with an offset (`2026-10-07T09:00:00Z`) or epoch milliseconds, and a time already past does not wait; `ctx.sleep({ minutes: 5 })` takes a duration from `ms`, `seconds`, `minutes`, `hours` and `days`, none negative. A request it can't read fails the run with `invalid_input`, as does an operation input its schema refuses.

### Drivers

A driver implements a connector's operations with `defineDriver(connector, { resource: { name: (input, call) => … } })`, typed by the connector's schemas. `call` carries `idempotencyKey`, the same on every retry and replay of one call: pass it to the vendor (or dedupe on it) so a crash between the vendor's reply and the checkpoint does not repeat the side effect. A driver reads its credentials when it is called, never from the config.

When the vendor says no, throw a `DriverError(message, { retryable, status?, vendorCode? })`. An operation declared `idempotent` is tried up to three times (after 1 and 2 seconds) unless the error says `retryable: false` or the reply fails the output schema; any other operation is tried once. When the tries run out, the run fails with the last try's error, so `errorCode(err)` is `"driver_failed"` and the ledger records the vendor's message, not a wrapper.

### Versions

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Set `version` in the config (a git commit, say) or leave it out to get a hash of each workflow's name, the source of its `run` function, its operations and its input schema. The hash cannot see functions `run` calls that live elsewhere, op schemas, drivers or the policy; a project that edits those between deploys should set `version`. A new version becomes the app's latest when it first starts, and runs queued without a version go to the latest; a worker started on an older version (a rollback) warns instead, unless started with `{ promote: true }`. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. On a local database, `pnpm db:down && pnpm db:up` resets it.

## Keeping workflows replay-safe

A run is replayed after a restart by calling the function again and reading each step's result back, so workflows and policies must do the same thing every time, and must reach vendors only through `ctx` so the policy sees every call. Two checks enforce that on files under `workflows/` and `policies/`.

oxlint, with the rules this package ships in `oxlint.json`, refuses the clock (`Date`, `performance`), randomness (`Math.random`, `crypto`), the network (`fetch`, `WebSocket`), timers, `process`, `globalThis`, and imports of `@sanoma/testing`, `@sanoma/app`, `@sanoma/connector-*/fake`, `@sanoma/connector-*/driver` and `SanomaClient`, `startWorker` or `startApp`. Each message names the `ctx` replacement. Extend it from your `.oxlintrc.json` (oxlint resolves `extends` as a path, not a package name; the `workflows/**` and `policies/**` globs resolve against your config):

```json
{
  "extends": ["./node_modules/@sanoma/workflows/oxlint.json"]
}
```

`lintWorkflow` from `@sanoma/workflows/lint` checks what oxlint can't express: imports come only from `@sanoma/workflows`, a `@sanoma/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` or `policies/` directory (so not `../sanoma.config.ts`, which holds the drivers); no namespace import of `@sanoma/workflows`; no dynamic `import()`. Run it over those directories in a test:

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

License: Apache-2.0.
