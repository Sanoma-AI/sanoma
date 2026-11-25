---
title: "Approval decisions"
description: "Look up client.decide arguments, return status, retries, and errors."
sidebar:
  order: 5
---

Use `client.decide` to send a decision for a pending approval. For the app procedure, see [Review an approval](/using-the-app/approvals/).

```ts
await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }, approvalId);
```

## Arguments and result

`client.decide(runId, { decision, by, note? }, approvalId?, { timeoutSeconds? })` identifies the run, names the person deciding, and accepts an optional note. Supply the approval ID to select a specific request. The run checks [who may approve](/workflows/approvals/#who-approves).

The method returns the decided approval when the run reads the decision. If the timeout expires (30 seconds by default), it returns the approval still `pending`. The decision stays queued for the worker.

## Errors and retries

| Code                  | When it occurs                                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `already_decided`     | The approval already has a decision. If a concurrent decision reached the run first, the error identifies who decided and how.                |
| `run_ended`           | The run finished, failed, or was cancelled.                                                                                                   |
| `no_pending_approval` | The run has no matching pending request.                                                                                                      |
| `run_not_found`       | The run ID does not exist.                                                                                                                    |
| `not_approver`        | The sender cannot decide this approval. The run also checks the sender when it reads the message and records a refusal as `approval.refused`. |

Each message has an ID. Supply `message.id` to reuse it when retrying a send. The approval scopes the idempotency key, so a retry with that ID queues one message. The run records the winning ID in `decidedWith` and publishes the decision on `decisionEventOf(approvalId)`.
