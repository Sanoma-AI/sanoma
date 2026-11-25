---
title: "Scenario API"
description: "Look up the server-side functions for loading feature files and checking sandbox runs."
sidebar:
  order: 8
---

## Compile and check scenarios

`sanoma/workflows/scenario` (server-side only; the lint refuses it in workflow files) compiles and checks them:

- `loadScenarios(resolveConfig(config))` resolves to `{ scenarios, errors }`: every scenario, compiled by Cucumber, and an error for each file that does not compile or name used twice. It reads the resolved config's `ops`, `workflows`, `types`, `steps` and `scenarios` (the directory). A scenario's `line` is its keyword's, or its examples row's.

  A scenario's `text` is its own lines of its file, for display: from its keyword line to the end of its last step (doc strings, tables and an outline's examples included), less that line's indent; its `steps` are each `{ text, kind, op?, name?, called?, decision?, fault? }`, in order: `op` names the operation a step is about, `name` the step a `step "…"` Then is about, `called` says whether a `Then` about either expects a call (or a run) or none (`ran 0 times` too), `decision` that it expects the policy to have denied it (`denied`) or held it (`held`), and `fault` marks a `Given` that injects a fault rather than seeding.

  It compiles the files again only when one has been added, removed or written since its last call with that config (a file's name, `mtimeMs` or size changed); until then it resolves to the same object, so the worker and the app can call it on every run and every request. Compiling builds Cucumber's support library from the config (once per resolved config) and runs the files: a few milliseconds.

- `check(scope, scenario, records)` runs the scenario's `Then` steps, as its feature file reads now, against a run's ledger records, and resolves to `{ step, ok, detail? }` for each expectation, in order; it rejects when the file no longer has the scenario as it was compiled (load the scenarios again first). Each `Then` is judged on its own, so one that does not hold leaves the rest checked.

  For the generic steps: a call matches when its parsed input contains the expected input (every field, at every depth); a call is an `op.called` record without an `error`, so one the policy denied, an approver rejected or the vendor failed for good was attempted, not made (`was not called` passes, and a failed `was called` lists the attempts in its `detail`); a denial is read from the `op.called` records' `decision`, a hold from `approval.requested` (its `op`, or its `covers`); a named step's runs from the `name` on the `op.called` (made), `sleep.started` and workflow-asked `approval.requested` records; an outcome is read from `run.finished` or `run.failed` (`ok: false`, "run not ended", before either); and a drift result from the `DriftReport` a `run.finished` holds as its `output`.

  A connector's or the company's `Then` whose `check` throws fails with the error's message.

- `testFeature(scope, file, line, { driver, fake? })` runs one scenario of a connector's own feature file as an operation's test, rejecting with its first step that did not pass at its `file:line`, and `featureScenarios(scope, dir)` lists a directory's scenarios from a dry run: what `describeFeatures` is built on.
- `drive(client, runId, scenario, { timeoutMs? })` decides the run's approvals as the scenario says until the run ends, and returns its `RunSummary`. Each pending approval takes the decision naming its title or id, else the next decision left that names no approval of the run: none it has asked for, and none in `scenario.approvals`, the titles its workflow's code asks for where they are string literals (read from its [outline](/workflows/your-own-ui/#outline)).

  So `"the first one"` is decided in order, but a decision for `"Final check"` is never spent on the approval before it. An approval with no such decision throws, naming the decisions left. Each decision waits for the run to read it until the timeout; a worker that has not read it by then throws `run_running`, as does a run still going. `by` is a person's id, so a scenario cannot decide an approval addressed to a group.

## Run one or more scenarios

`runScenarios(config, { databaseUrl, startedBy?, timeoutMs?, log? })` from `sanoma/workflows/scenarios` (server-side only, like `/scenario`) runs every scenario of the config as a sandbox run, on a worker it starts on `databaseUrl` with an in-memory ledger and stops after, and returns `{ passed, failed }`: the names of the scenarios whose every check held, and one `{ scenario, step, message }` per step that did not (with `check`'s detail), per run that could not be driven to its end (at its `When` step), and per feature file that did not load (`step: "did not load"`); a config whose root has no `scenarios/` passes and fails nothing.

`runScenario(scenario, { client, scope, startedBy?, timeoutMs? })`, re-exported from `sanoma/workflows/scenarios`, runs one scenario against a worker you started, with a `SanomaClient` of it, and returns `{ runId, run, ledger, checks }`: the run's id, its summary, its ledger records and `check(scope, scenario, ledger)`. `timeoutMs` goes to `drive`. Load the scenarios with `await loadScenarios(scope)` from `sanoma/workflows/scenario`, `scope` being `resolveConfig(config)`.

Set `startedBy` to choose the actor for scenarios that omit an acting step. For Vitest integration, see [Run scenarios with Vitest](/testing/workers/#run-scenarios-with-vitest).

## Sandbox runs in the client

`client.start(workflow, input, { startedBy, sandbox: "<scenario name>" })` uses the caller’s input. Use `scenario.input` to reproduce the feature’s input. An empty scenario name is `invalid_input`. Reusing a run ID with a different sandbox or input is also `invalid_input`. `RunSummary.sandbox` contains the name stored in DBOS’s run attributes.

| Record or result           | What it contains                                                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scenario.seeded`          | Follows `run.started` after the `sandbox:seed` step. Operation seeds record input and output. Resource seeds record the type, import ID, and fields or `gone: true`.                                                                                                         |
| `client.runChecks(runId)`  | Returns each expectation and whether it has settled, or the reason checks are unavailable. The runtime stores these results separately from the ledger.                                                                                                                      |
| `invalid_input` on the run | The scenario is missing, targets another workflow, needs an unavailable fake, or seeds a resource the fake cannot represent. Invalid seed fields identify the step. Replaying the seeding checkpoint after a restart or in a fork also fails because the fake state is gone. |

Inspect the ledger and status for sandbox failures. The worker suppresses DBOS log output from the sandbox, including expected transient errors injected by its fakes.
