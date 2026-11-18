---
title: Direct calls
description: "An operation may also be called directly, outside a run, as the person on a page."
sidebar:
  order: 7
---

An operation may also be called directly, outside a run, as the person on a page: `isDirect(op, types)` says which, the one rule the app and the SDK read (`describeConfig` gives it as each operation's `direct`). A collection's operations may, and a vendor's `read`, but not the runtime's own (`sanoma.source.resolve`) or a resource type's (`isResourceOp`: only drift and apply call those); anything with an effect at a vendor is a workflow's.

```ts
const saved = await client.call("data.outbound.save", { record }, { actor: { id: "ada" }, id: requestId });
const customer = await client.call("stripe.customer.get", { id }, { actor: { id: "ada" } });
```

`client.call(opId, input, { actor, id? })` refuses an unknown operation, one that may not be called directly and input its schema refuses (`invalid_input`). The policy decides the call as the person, in a run `direct:<actor>:<id>` of the workflow `call` with no approvals (`id` is a new UUID unless given). A deny throws `policy_denied` and writes nothing. An allowed call runs the driver once, without DBOS and without a retry, as `CallContext` `{ idempotencyKey, runId }` both that run id and `by` the person's id; a failure is `driver_failed`. A read returns its output and records nothing, so a page polling it does not fill the ledger. A write is one `op.called` record (seq 0) of that run, a [batch](/workflows/collections/#batches) one per entry (seq 0, 1, ...), and with the default ledger they are in one Postgres transaction with the records it saves: all are kept, or none. The same id with the same input returns the output recorded, without writing again; with another operation or input it is refused (`invalid_input`, `differs`). When the policy asks for an approval, the call becomes a run of the built-in `call` workflow (`CALL_WORKFLOW`), started as the person with run id `call:<actor>:<id>` and input `{ op, input }`: its one call is held like any run's, shows in `client.approvals`, and once approved is made as the person (a save's `updatedBy` is theirs). `client.call` throws `approval_pending` (`ApprovalPendingError`) with `data` `{ runId, workflow: "call", op }`, and so does the same call again (same id) while that run waits; once it has ended, the same call returns what the run returned (or throws its error), without asking the policy again. A write whose driver failed keeps its failure under its id: call again with another id to try again. The `call` workflow `uses` every operation that may be called directly and has a driver; `resolveConfig` adds it when there is one, and a config's own workflow may not be named `call`.

`client.latest(workflow)` is the newest finished run of a workflow, `{ runId, output, at }` (`at` when it finished), or `null`: one query, for a page that shows a workflow's last result.

## Calls run one at a time

A run's ctx calls run one at a time, in program order. Even inside `Promise.all`, each call waits for the one before it to settle, so two calls a policy holds for approval are asked for one after the other. DBOS matches a replayed call to its recorded result by the order calls reach it, so calls left to race would replay out of step. A call that fails rejects its caller. The calls queued after it still run only if the workflow catches the failure and goes on; otherwise the body has ended, and each queued call is refused with `run_ended` (the run has ended, so the call is never made) instead of reaching its vendor, an approver or a sleep. Write calls one after another, as the workflow means them, and a fan-out with `ctx.all`.
