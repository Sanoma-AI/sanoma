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

const policy = definePolicy(({ effect, run }) => {
  if (effect !== "money") return allow();
  const financeApproved = run.approvals.some((a) => a.status === "approved" && a.decidedBy === "finance-lead");
  return financeApproved ? allow() : approve("finance-lead");
});

export default defineConfig({ workflows: [refund], drivers, policy, ledger: jsonlLedger(".sanoma/ledger") });
```

A policy returns `allow()`, `deny(reason)` (the run fails) or `approve(who)` (the run waits for that person). It sees the operation, its input, who started the run and the run's approvals so far, and it must decide the same way on every replay: no clock, randomness or network. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided, and how the run ended, in a JSONL file per run.

`startWorker(config)` runs workflows and recovers interrupted runs. `SanomaClient` starts runs as a named person, lists them, records approval decisions and reads a run's ledger.

Status: early (0.x). The API may change between minor versions.

License: Apache-2.0.
