---
title: Direct calls
description: "Which operations a page can call directly, how policy applies, and when a call creates a run."
sidebar:
  order: 7
---

A page can call some operations as its signed-in actor without starting a workflow. The app and SDK use `isDirect(op, types)` to check eligibility. `describeConfig` exposes the result as the operation’s `direct` field.

Direct calls support collection operations, vendor reads, and a [company operation](/workflows/your-own-operations/#from-a-page) when all the operations it uses also qualify. Run vendor side effects in a workflow. Runtime operations such as `sanoma.source.resolve` are ineligible. Resource operations (`isResourceOp`) are reserved for drift and apply.

```ts
const saved = await client.call("data.outbound.save", { record }, { actor: { id: "ada" }, id: requestId });
const customer = await client.call("stripe.customer.get", { id }, { actor: { id: "ada" } });
```

## Policy and recorded results

`client.call(opId, input, { actor, id? })` refuses an unknown operation, one that may not be called directly and input its schema refuses (`invalid_input`). The policy decides the call as the person, in a run `direct:<actor>:<id>` of the workflow `call` with no approvals (`id` is a new UUID unless given). A deny throws `policy_denied`, and the call denied writes nothing (a company operation that writes records a deny inside it as its error, below).

An allowed call runs the driver once, without DBOS and without a retry, as `CallContext` `{ idempotencyKey, runId }` both that run id and `by` the person's id; a failure is `driver_failed`. A read returns its output and records nothing, so a page polling it does not fill the ledger. A write is one `op.called` record (seq 0) of that run, a [batch](/workflows/collections/#batches) one per entry (seq 0, 1, ...), and with the default ledger they are in one Postgres transaction with the records it saves: all are kept, or none.

### Repeating a call or waiting for approval

The same id with the same input returns the output recorded, without writing again; with another operation or input it is refused (`invalid_input`, `differs`). When the policy asks for an approval, the call becomes a run of the built-in `call` workflow (`CALL_WORKFLOW`), started as the person with run id `call:<actor>:<id>` and input `{ op, input }`: its one call is held like any run's, shows in `client.approvals`, and once approved is made as the person (a save's `updatedBy` is theirs).

`client.call` throws `approval_pending` (`ApprovalPendingError`) with `data` `{ runId, workflow: "call", op }`, and so does the same call again (same id) while that run waits; once it has ended, the same call returns what the run returned (or throws its error), without asking the policy again. A write whose driver failed keeps its failure under its id: call again with another id to try again.

A company operation called directly runs its body, each call it makes a direct call of its own in the same run (`direct:<actor>:<id>`, seq from 1): decided with the operation's id as the run's workflow, recorded within the operation's call when it writes, and held as the whole operation. One that writes records its own `op.called` at seq 0 once its body has ended, with its output, or its error unless a call inside waits on an approval: a deny of a call inside is that error, and the same id again throws the same `policy_denied`; one that only reads records nothing.

A `connection` given it is dropped, as in a run: it has no account of its own. The `call` workflow `uses` every operation that may be called directly and has a driver, and every company operation that may; `resolveConfig` adds it when there is one, and a config's own workflow may not be named `call`.

`client.latest(workflow)` is the newest finished run of a workflow, `{ runId, output, at }` (`at` when it finished), or `null`: one query, for a page that shows a workflow's last result.

## Calls run one at a time

A run's ctx calls run one at a time, in program order. Even inside `Promise.all`, each call waits for the one before it to settle, so two calls a policy holds for approval are asked for one after the other. DBOS matches a replayed call to its recorded result by the order calls reach it, so calls left to race would replay out of step. A call that fails rejects its caller.

The calls queued after it still run only if the workflow catches the failure and goes on; otherwise the body has ended, and each queued call is refused with `run_ended` (the run has ended, so the call is never made) instead of reaching its vendor, an approver or a sleep. Write calls one after another, as the workflow means them, and a fan-out with `ctx.all`.
