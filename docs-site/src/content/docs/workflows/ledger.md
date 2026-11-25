---
title: The ledger
description: See what happened in one workflow run and trace calls that acted on the same target across runs.
sidebar:
  order: 9
---

The ledger is the audit record of a workflow run. It shows who started the run, which operations it called, what the policy decided for each call, which approvals applied, and how the run ended. The app’s run page and `client.ledger(runId)` show the same sequence of events. Each event is a `LedgerRecord`, ordered by `seq`.

Some values must not reach whoever reads the ledger. An operation's `opaque` fields (a resource type's `handle`, an attachment's bytes, a minted token; [resources](/workflows/resources/)) are recorded as `"<name>"` in its `op.called` record, its input and its output. A workflow's `opaque` fields ([writing workflows](/reference/workflow-runtime/#output-for-the-starter-alone)) are recorded the same way in its `run.finished` record. The app's run page shows each such field as "redacted".

## One run and one target

A run can act on several records, and several runs can act on the same record. For example, an operation might act on the Acme record on the Outbound board. If the operation declares a target, its `op.called` event records the instance the policy saw, in this case `data:outbound/Acme`.

`client.history(target, limit?)` brings together calls for that target across runs, newest first. It includes reads and writes made during a run, plus direct writes. The `effect` field distinguishes reads from writes. Direct reads leave no ledger record.

## Repeated records

After a restart, a run can replay and submit the same events with the same IDs. Every ledger store keeps the first record for each ID. A replay can fill in events the interrupted run never recorded, while each earlier event still appears only once. If a later record with the same ID differs, the store warns and keeps the original.

If an `append` fails, Sanoma retries it up to three times. A final error (`retryable: false`) stops retries. Examples include a record that cannot be stored as JSON or a corrupt ledger file.

If the vendor has replied and the ledger still cannot record the call, the call fails with `<op id> succeeded, but the ledger could not record it`. The run refuses further calls with `run_ended`, so catching the error cannot repeat the unrecorded side effect.

## What the ledger records

The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested, decided and withdrawn (`approval.withdrawn` with its `reason`; a policy's hold names the call it holds by its `op` and `opSeq`, the `seq` that call's own record has), each message an approval ignored (`approval.refused`: sent by someone who may not decide it, or not a decision), each sleep (`sleep.started` with `until`, when it ends in ms since the epoch: the time asked for, or for a duration, the record's `at` plus the duration, as the runtime saw it; written for a time already past too), and how the run ended, in a JSONL file per run.

A decision is recorded with its `reasons` (the ids of the policies behind it) and, with Cedar policies, their `policyVersion`, a hash of their text.

Every record carries `v: 1`, the `app` and the `actor`, and one written inside a `ctx.all` member its `group` (see [Built-ins](/workflows/built-ins/)); each call's record (`op.called`, `approval.requested`, `sleep.started`) carries its step's `name` (see [Step names](/workflows/built-ins/#step-names)); an error is recorded as `{ code?, name, message }`, with `retryable` when the error says, the vendor's `status` and `vendorCode` only from a `DriverError`, and `data` only from the runtime's own errors (the operation, the approval, the input's issues), so an HTTP client's error that escapes a driver does not put the vendor's reply in the ledger.

## Stores

The config’s `ledger` option selects the store. Each `LedgerStore` implements `append`, `read`, and `readByTarget`. A store that holds a connection also provides `close`.

| Store | Where it keeps records |
| --- | --- |
| `postgresLedger(databaseUrl)` | The default. The worker, app, and other processes share the `sanoma_ledger` table in the configured database alongside the DBOS tables. Each process can use its own disk. |
| `jsonlLedger(dir)` | One file per run at `<dir>/<runId>.jsonl`, with one JSON record per line. The files can live on disk or in a repo. |
| `memoryLedger()` | In the current process, for tests. |

On first use, the Postgres store creates its table and, if needed, the database. The app can therefore read the ledger before a worker has run. With the default store, the worker and client each own a store and close it on `stop` or `client.close()`, respectively. Closing a store permanently ends its connection pool. If the config supplies a store, the config owns its cleanup.
