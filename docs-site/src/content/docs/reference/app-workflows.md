---
title: "Built-in app workflows"
description: "Look up the worker steps used when the app saves, adopts resources, or puts a company online."
sidebar:
  order: 12
---

What the app does to the company's repository is a run of a built-in workflow, never a write in the app's own process, so it works wherever the app is served (a Node process, a Cloudflare Worker) as long as a worker runs: `adopt` (a drifted field's value at the vendor written into its data file), `patch` (a form's Save; with a column change's `plan` and no remote, it also brings the records along, `reshaped` in its output, and has the worker start again on the new declaration, `running`, as [A column change](/workflows/collections/#a-column-change) says), `go-live` and `go-live-host` (`infra.ts` written, then `main` pushed), `go-live-cloud` (going live on a host in its vendor's account, as `infra.ts` declares it: its address written when it changed, the repository made there, `main` pushed, then the database and the host applied and waited for), `connect-existing`, and `save-draft` (a chat's draft saved, as [Changes](/workflows/changes/) says).

Their names are `sanoma/workflows/shared`'s `ADOPT_WORKFLOW` and the rest. `resolveConfig` adds them to every config, so a company workflow may not take their names, and `describeConfig` lists them with `builtin: true`. Each takes a zod input (`AdoptInput`, `PatchInput`, `GoLiveInput`, `GoLiveHostInput`, `GoLiveCloudInput`, `ConnectExistingInput`, `SaveDraftInput`), refused at the start, and its run is a step: the app's page starts it and polls its `.result`.

What each does is the app's, given to the worker as `AppSteps` (`startWorker(config, { app, source })`; `sanoma serve` and `sanoma worker` give theirs, `sanoma/app/steps`). The run calls its step in a DBOS step of its own (`app:<name>`) with an `AppStepContext`: the worker's own `SanomaClient` (connected on first use, closed when the worker stops), its `source`, its `reload` when it was given one, and `serially`, the worker's one lock on it, which a step holds around reading, writing and committing the checkout, the config and its resolution, who started the run (`by`) and the run's id.

A step refuses by throwing: a `SanomaError` whose code and data the page reads (`invalid_input` with its `issues` or a `field`, `not_approver`), else an error whose message the run fails with.

A step that applies after its write answers what to apply (`{ apply }`), which the run starts as its child, `<run>:apply`, as its own actor, and answers that run's id without waiting for it: an apply may wait for its plan's approval in the Inbox. `go-live-cloud` is the one that waits (`AppRunner.applyAndWait`), failing when the apply left a step undone, and the one that calls an operation: the host type's `account.repository`, through `ctx`, so the policy decides it and the ledger records it.

On a worker without app steps each run fails, saying so. The pages call them through `api`, typed as `AppApi`.
