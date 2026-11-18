---
title: The ledger
description: "The ledger is the audit record of a run: who started it, every operation call with the policy's decision, every approval, and how it ended, as LedgerRecords in seq order."
sidebar:
  order: 9
---

The ledger is the audit record of a run: who started it, every operation call with the policy's decision, every approval, and how it ended, as `LedgerRecord`s in `seq` order. `client.ledger(runId)` reads it, and the app's run page shows it. Each `op.called` record names its `target` when the operation declares one (`data:outbound/Acme`: the instance the call acted on, as the policy saw it), and `client.history(target, limit?)` reads the calls that acted on one across every run, direct writes among them, newest first: a run's reads of the record too (each record's `effect` tells them from the writes), never a direct read, which is not recorded. Three stores keep it, each a `LedgerStore` (`append`, `read`, `readByTarget`, and `close` for one that holds a connection), and a config picks one with `ledger`:

- `postgresLedger(databaseUrl)`, the default when `ledger` is not set: one table, `sanoma_ledger`, in the config's database beside DBOS's own, which the worker, the app and other processes then share without sharing a disk. The table is made on first use, and the database with it when it is not there (as a worker's launch makes it), so the app may read before any worker has run. The worker and the client (so the app) each make their own store and close it with themselves (`stop`, `client.close()`); `close()` ends its pool for good. A store the config gives is the config's to close: the runtime never closes it.
- `jsonlLedger(dir)`: `<dir>/<runId>.jsonl`, one record per line, for a ledger on disk or in a repo.
- `memoryLedger()`: this process only, for tests.

Every store keeps the first record of an id: a run replayed after a restart writes its records again, with the same ids, and the store skips them (warning when a later one differs). A failed `append` is tried again three times, unless the store says the failure is final (`retryable: false`): a record that is not JSON, a corrupt file.
