---
title: Drivers
description: "Implement connector operations, handle retries safely, and report a vendor’s refusal."
sidebar:
  order: 3
---

A driver implements the operations a connector declares. Use `defineDriver(connector, { resource: { name: (input, call) => … } })` to type the implementation against the connector’s schemas. Attach the driver to the exported connector with `withSetup`.

Pass `call.idempotencyKey` to the vendor or use it to deduplicate calls. The key stays the same across retries and replays. If the worker stops after the vendor responds but before the result is checkpointed, the same key protects against repeating the side effect.

The call includes the authenticated `principal`, selected `connection` metadata, and `by` (the identity making the call, `run:<id>` inside a run). Its `secrets` store resolves `secret()` markers. Declare credentials and read them at call time. See [Secrets](/hosting/secrets/#secrets) and [Credentials](/workflows/credentials/).

## Errors

When the vendor refuses a call, throw `DriverError(message, { retryable, status?, vendorCode? })`. Sanoma attempts an `idempotent` operation up to three times, waiting 1 second before the second attempt and 2 seconds before the third. A nonretryable error (`retryable: false`) or a response that fails the output schema stops retries. Other operations get one attempt.

If all attempts fail, the run reports the last error. For a `DriverError`, `errorCode(err)` returns `"driver_failed"` and the ledger records the vendor’s message, status, and code. Other exceptions, such as `TypeError` or a plain `Error`, propagate without a code.

An error that holds a value the driver read (through `call.secrets`, a `secret()` marker, or a variable its `env` declares, eight characters or more) anywhere in its message, stack, cause or properties is replaced before it is recorded or thrown: a `DriverError` with that message, each value as `[redacted]`, keeping only what a `DriverError` said of itself (`status`, `vendorCode`, and `retryable`, which is false otherwise). An error that ends the run (a cancellation) is left as it is.

A named connection's driver error is already replaced by `<vendor> operation failed`. A result is recorded as the driver returns it: a driver that returns what it read is trusted to.

## Calling Cloud workflows

A driver that calls one of Sanoma Cloud's workflows (sanoma-ops's: the Sanoma Cloud connector, and the GitHub connector for a Cloud company's token) runs it with `cloudRun(workflow, input, { token, id?, timeoutMs?, runTimeoutMs? })`: `POST <SANOMA_CLOUD_URL>/api/call` (`https://www.sanoma.work` unless set) with the company's Cloud token (`CLOUD_TOKEN`, `SANOMA_CLOUD_TOKEN`) as a bearer, `<workflow>.start` (with `id`, so a retry of the call resumes the same run), then `<workflow>.result` until the run ends; it answers the run's output, and fails with a `DriverError` (a failed run's refusal, `run_running` past `runTimeoutMs`, retryable), never saying the token.
