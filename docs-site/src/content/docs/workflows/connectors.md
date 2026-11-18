---
title: Drivers
description: "A driver implements a connector's operations with defineDriver(connector, { resource."
sidebar:
  order: 3
---

A driver implements a connector's operations with `defineDriver(connector, { resource: { name: (input, call) => … } })`, typed by the connector's schemas, and its package attaches it to the connector it exports (`withSetup`). `call` carries `idempotencyKey`, the same on every retry and replay of one call: pass it to the vendor (or dedupe on it) so a crash between the vendor's reply and the checkpoint does not repeat the side effect. It carries the authenticated `principal` and selected `connection` metadata, and `secrets` too, the store `secret()` markers name (see [Secrets](/hosting/secrets/#secrets)), and `by`, who the call is made as (`run:<id>` inside a run). A driver reads its credentials when it is called, never from the config, and declares them (see [Credentials](/workflows/credentials/)).

## Errors

When the vendor says no, throw a `DriverError(message, { retryable, status?, vendorCode? })`. An operation declared `idempotent` is tried up to three times (after 1 and 2 seconds) unless the error says `retryable: false` or the reply fails the output schema; any other operation is tried once. When the tries run out, the run fails with the last try's error, not a wrapper: for a `DriverError`, `errorCode(err)` is `"driver_failed"` and the ledger records the vendor's message, status and code. Anything else a driver throws (a `TypeError`, a plain `Error`) fails the run as it is, with no code.

An error that holds a value the driver read (through `call.secrets`, a `secret()` marker, or a variable its `env` declares, eight characters or more) anywhere in its message, stack, cause or properties is replaced before it is recorded or thrown: a `DriverError` with that message, each value as `[redacted]`, keeping only what a `DriverError` said of itself (`status`, `vendorCode`, and `retryable`, which is false otherwise). An error that ends the run (a cancellation) is left as it is. A named connection's driver error is already replaced by `<vendor> operation failed`. A result is recorded as the driver returns it: a driver that returns what it read is trusted to.

## Calling Cloud workflows

A driver that calls one of Sanoma Cloud's workflows (sanoma-ops's: the Sanoma Cloud connector, and the GitHub connector for a Cloud company's token) runs it with `cloudRun(workflow, input, { token, id?, timeoutMs?, runTimeoutMs? })`: `POST <SANOMA_CLOUD_URL>/api/call` (`https://www.sanoma.work` unless set) with the company's Cloud token (`CLOUD_TOKEN`, `SANOMA_CLOUD_TOKEN`) as a bearer, `<workflow>.start` (with `id`, so a retry of the call resumes the same run), then `<workflow>.result` until the run ends; it answers the run's output, and fails with a `DriverError` (a failed run's refusal, `run_running` past `runTimeoutMs`, retryable), never saying the token.
