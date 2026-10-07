# @sanoma/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. A lint (`lintWorkflow`) checks that workflow code is safe to replay.

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

A policy returns `allow()`, `deny(reason)` (the run fails) or `approve(who)` (the run waits for that person). It sees the operation, its input, who started the run (`actor`) and the run's approvals so far, and it must decide the same way on every replay: no clock, randomness or network. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided, each message an approval ignored (`approval.refused`: sent by someone other than the approver, or not a decision), and how the run ended, in a JSONL file per run. Every record carries `v: 1`, the `app` and the `actor`; an error is recorded as `{ code?, name, message }`.

People are `Principal`s: `{ id, groups? }`. A run is started as one and a decision is sent as one:

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice", groups: ["support"] } });
await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } });
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`startedBy` is required. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)` returns the same config as plain JSON (its version, each workflow's input as JSON Schema and the operations it may call, each operation's effect and contract), which is what a UI renders from.

### Versions

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Set `version` in the config (a git commit, say) or leave it out to get a hash of each workflow's name, code and operations; drivers and the policy are not in the hash. A worker becomes the app's latest version when it starts, and runs queued from then on go to it. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. On a local database, `pnpm db:down && pnpm db:up` resets it.

Status: early (0.x). The API may change between minor versions.

License: Apache-2.0.
