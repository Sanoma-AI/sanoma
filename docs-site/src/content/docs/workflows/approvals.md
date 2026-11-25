---
title: Approvals
description: "How Sanoma chooses an approver, matches a decision to a held call, and handles a withdrawn approval."
sidebar:
  order: 10
---

A workflow can ask for a decision with `ctx.approval(title, { approver, covers?, links?, details? })`. A policy can also hold a call with `@hold`. Both create entries in `run.approvals`. The entry’s `status` tells you whether the decision is still pending.

## What an approval covers

The `covers` field lists operation IDs. A policy hold covers the operation it held. A workflow approval covers the operations the workflow names, which can be an empty list.

To lift a hold, `approvedFor(run.approvals, op.id, approver)` requires an approved decision for that operation addressed to the hold’s approver. This ensures a workflow cannot use another person’s sign-off to satisfy the hold. A withdrawn decision no longer qualifies.

Coverage applies to the operation throughout the run. For example, approval for `shop.order.refund` covers later refund calls in that run even when their inputs differ.

## Who approves

The approver is a person's id (`"finance-lead"`), or `{ group: "finance" }` for anyone whose principal lists that group in `groups`. A group's name is not a person: `{ id: "finance" }` is not in the group `finance`.

`mayDecide(approval, principal, run, people)` is the check the run, the client and the app's Inbox all use; it also refuses the run's own actor while someone else could decide, that is while the approver is a group with another declared person in `people` (the declared people resources; an agent in the group, declared or the runtime's own, does not count; `own change`: nobody decides on their own change, though a person may decide on a run an agent started for them, their own agent acting for them through `/mcp` among them: the run's actor is the agent).

When nobody else could (the approver is the starter by id, or a group they alone are in), the starter decides, and the `approval.decided` record and the approval say `alone: true`. A policy hold's title is its `@title`, else `<op id> needs <approver>`, the approver shown as `group finance` for a group.

A policy hold's approval also carries the held call: its `op`, its parsed `input`, `opSeq`, the ledger `seq` of the call's `op.called` record, so a UI can show the hold on the call it held, and `reasons`, the ids of the policies that held it.

## Deciding a run's start

The policy decides every run's start too, the runtime's workflows' as the company's, as the action `workflow:<name>` with the input as its context, before `client.start` queues it, twice when an agent acts for someone (see [People](/policies/people/)). A visitor starts none of the runtime's workflows. The internal workflows (`call`, `chat`, `change`, `connect`, `follow`, `login-code`, `reshape`, `save-draft`) are started by Sanoma alone, never through `client.start`: a start of one is `invalid_input`, whatever the policy says, and their runs read as any other's.

One rule is the runtime's own: once the company's policy allows it, a declared agent's start of one of the runtime's workflows that does not only read (`apply`, say; `drift` and `plan` only read) waits for an approval by the group `admin`, with the reason `sanoma:agents-wait-for-admin`. A company `@hold` on the same start comes first. While no person is in the group `admin` (none declared, an empty one, or one of agents alone), the start is refused, saying so. A company lifts the rule with a `permit` for agents that the start satisfies:

```cedar
@id("agents-apply")
permit (principal in Sanoma::Group::"agents", action == Sanoma::Action::"workflow:apply", resource);
```

A `permit` is allowed only for visitors and agents, so for a person "the policy allows it" means no `forbid` refuses or holds it; one for agents only lifts this rule, and lets no visitor or api token in, whatever its groups. A deny throws `policy_denied` and starts nothing; a hold starts the run, which waits on the approval (`op: "workflow:<name>"`, no `opSeq`) before its body runs, and fails if it is rejected.

A held apply waits off the apply queue, so it keeps no other apply waiting: once approved, it runs as its child, `<runId>:apply`, on the queue, and its run's result is the child's report ([Apply](/workflows/resources/#apply)).

## Sending a decision

In the app, [review the request in Inbox](/using-the-app/approvals/). From a client, use [`client.decide`](/reference/approval-decisions/) to send a decision and check its status.

## Withdrawn approvals

An approval that no longer stands, as when its change gets a new commit, is withdrawn: its `status` becomes `withdrawn`, with `withdrawnReason`, `withdrawnAt` and `withdrawnBy` (who, unless its run withdrew it), and the ledger gets `approval.withdrawn` with the same `reason` and `by`.

`client.withdraw(runId, approvalId, reason, { by, timeoutSeconds? })` withdraws a pending one, as the run's starter or someone who may decide it (`not_approver` otherwise; a visitor never), and refuses as `decide` does (`already_decided` once it is not pending); the run reads the withdrawal as it would a decision (an `ApprovalWithdrawal` message, `{ withdraw: reason, by, id? }`, on the approval's topic), checks `by` again (refusing as `approval.refused` otherwise), sets `decidedWith`, and the call or `ctx.approval` waiting on it throws `WithdrawnError` (`approval_withdrawn`, with `approvalId` and `reason`); a held call records it as its failed `op.called`, as a rejection.

A decision sent after it is `already_decided`. A built-in withdraws its own approved approvals of an operation from its body, so they lift no later hold on it.
