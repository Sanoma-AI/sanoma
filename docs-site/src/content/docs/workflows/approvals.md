---
title: Approvals
description: "An approval comes from the workflow (ctx.approval(title, { approver, covers?, links?, details? })) or from the policy holding a call (a @hold)."
sidebar:
  order: 10
---

An approval comes from the workflow (`ctx.approval(title, { approver, covers?, links?, details? })`) or from the policy holding a call (a `@hold`). Each is in `run.approvals` with its `status`, so a later call it covers is let through once it is approved.

## What an approval covers

`covers` says which operations an approval stands for, as op ids in the approval's state. A policy hold covers the operation it held; a workflow's approval covers the operations it names, or none. The runtime lifts a hold with `approvedFor(run.approvals, op.id, approver)`: approved, covering this operation, and addressed to the hold's approver. The last part matters: a workflow can request an approval covering any operation from anyone it names, so a check on `covers` alone would let a workflow launder a sign-off through its own `ctx.approval`. A withdrawn approval is no longer approved, so it lifts nothing. Covers name operations, not inputs: an approval that covers `shop.order.refund` covers every later refund call in the run.

## Who approves

The approver is a person's id (`"finance-lead"`), or `{ group: "finance" }` for anyone whose principal lists that group in `groups`. A group's name is not a person: `{ id: "finance" }` is not in the group `finance`. `mayDecide(approval, principal, run, people)` is the check the run, the client and the app's Inbox all use; it also refuses the run's own actor while someone else could decide, that is while the approver is a group with another declared person in `people` (the declared people resources; an agent in the group, declared or the runtime's own, does not count; `own change`: nobody decides on their own change, though a person may decide on a run an agent started for them, their own agent acting for them through `/mcp` among them: the run's actor is the agent). When nobody else could (the approver is the starter by id, or a group they alone are in), the starter decides, and the `approval.decided` record and the approval say `alone: true`. A policy hold's title is its `@title`, else `<op id> needs <approver>`, the approver shown as `group finance` for a group.

A policy hold's approval also carries the held call: its `op`, its parsed `input`, `opSeq`, the ledger `seq` of the call's `op.called` record, so a UI can show the hold on the call it held, and `reasons`, the ids of the policies that held it.

## Deciding a run's start

The policy decides every run's start too, the runtime's workflows' as the company's, as the action `workflow:<name>` with the input as its context, before `client.start` queues it, twice when an agent acts for someone (see [People](/policies/people/)). A visitor starts none of the runtime's workflows. The internal workflows (`call`, `chat`, `change`, `connect`, `follow`, `login-code`, `reshape`, `save-draft`) are started by Sanoma alone, never through `client.start`: a start of one is `invalid_input`, whatever the policy says, and their runs read as any other's.

One rule is the runtime's own: once the company's policy allows it, a declared agent's start of one of the runtime's workflows that does not only read (`apply`, say; `drift` and `plan` only read) waits for an approval by the group `admin`, with the reason `sanoma:agents-wait-for-admin`. A company `@hold` on the same start comes first. While no person is in the group `admin` (none declared, an empty one, or one of agents alone), the start is refused, saying so. A company lifts the rule with a `permit` for agents that the start satisfies:

```cedar
@id("agents-apply")
permit (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:apply", resource);
```

A `permit` is allowed only for visitors and agents, so for a person "the policy allows it" means no `forbid` refuses or holds it; one for agents only lifts this rule, and lets no visitor or api token in, whatever its groups. A deny throws `policy_denied` and starts nothing; a hold starts the run, which waits on the approval (`op: "workflow:<name>"`, no `opSeq`) before its body runs, and fails if it is rejected.

## Sending a decision

`client.decide(runId, { decision, by, note? }, approvalId?, { timeoutSeconds? })` refuses without sending when the approval is decided already (`already_decided`), when the run has finished, failed or been cancelled (`run_ended`: no run would read the decision), when there is nothing pending (`no_pending_approval`, `run_not_found`) or when `by` may not decide (`not_approver`, naming the approver or group). Otherwise it sends the decision and waits for the run to read it, then returns the approval as decided: the run publishes it on the event `decisionEventOf(approvalId)`. If another decision reached the run first (someone else's, or another of yours), it throws `already_decided` with who decided and how: each message carries an `id` (a new one unless `message.id` is given), and the approval records the one it was decided with as `decidedWith`.

The id is also the send's idempotency key, scoped to the approval, so a retried send queues one message. If the run does not read the decision within `timeoutSeconds` (30 by default), for instance because no worker is running, it returns the approval still `pending`; the decision stays queued and the run reads it when it next runs. The run checks the sender again and records anything it refuses as `approval.refused`; when it refuses this decision, `decide` throws `not_approver` rather than returning the approval pending.

## Withdrawn approvals

An approval that no longer stands, as when its change gets a new commit, is withdrawn: its `status` becomes `withdrawn`, with `withdrawnReason`, `withdrawnAt` and `withdrawnBy` (who, unless its run withdrew it), and the ledger gets `approval.withdrawn` with the same `reason` and `by`. `client.withdraw(runId, approvalId, reason, { by, timeoutSeconds? })` withdraws a pending one, as the run's starter or someone who may decide it (`not_approver` otherwise; a visitor never), and refuses as `decide` does (`already_decided` once it is not pending); the run reads the withdrawal as it would a decision (an `ApprovalWithdrawal` message, `{ withdraw: reason, by, id? }`, on the approval's topic), checks `by` again (refusing as `approval.refused` otherwise), sets `decidedWith`, and the call or `ctx.approval` waiting on it throws `WithdrawnError` (`approval_withdrawn`, with `approvalId` and `reason`); a held call records it as its failed `op.called`, as a rejection. A decision sent after it is `already_decided`. A built-in withdraws its own approved approvals of an operation from its body, so they lift no later hold on it.
