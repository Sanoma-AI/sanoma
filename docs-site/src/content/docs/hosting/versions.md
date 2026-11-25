---
title: Versions
description: "How a worker chooses which runs to recover after a restart, deployment, or rollback."
sidebar:
  order: 5
---

Each run records its worker’s application version as `<appName>@<version>`. A worker normally recovers only runs from its own version. Three built-in workflows have [special recovery rules](#runs-that-outlive-their-version).

Sanoma hashes each workflow’s name, `run` function source, operations, and input schema. DBOS needs the workflow code for this calculation because all workflows share the same runtime registration wrapper. The hash uses the code as it runs, so TypeScript source and its compiled JavaScript produce different versions.

The hash does not cover external helper functions called by `run`, operation schemas, drivers, or policy. Change those when no run is in flight, or restart on the old code first. To supply a version such as a Git commit, set `DBOS__APPVERSION`. Sanoma still prefixes it with the app name.

A new version becomes the app’s latest when it first starts. Unversioned queued runs go to that version. A worker starting an older version issues a rollback warning unless it starts with `{ promote: true }`.

## Runs that outlive their version

Three built-in workflows are the exception: a deploy restarts the worker on the merged code, a new version, and the `apply` and `change` runs that made the deploy have to outlive their version, as does a move between secret stores (`migrate-store`). Each run of a built-in workflow carries a hash of that workflow's own code (its `builtInCode` attribute: what the version hashes of the workflow, with the runtime's and DBOS's versions, never the company's workflows).

A worker that starts as the app's latest version takes over the unfinished `apply`, `change` and `migrate-store` runs of other versions whose hash is its own, keeping each run's id, its completed steps and the messages it has not read yet (an approval decided, an event told while no worker ran). It says so in one line at `info`. Runs of the company's workflows stay on their version; so does a carried workflow's run whose hash differs, after an upgrade of the runtime.

An apply queued and never started is taken over whatever its hash, since it has no completed steps to replay: it runs on the new code in its place on the apply queue, so a push's deploy queued behind a change's still runs. An apply started on other code (the runtime upgraded under it) is cancelled instead, because no worker would ever run it and it would hold the apply queue's one place for good, or, held at its start, leave its approval waiting for good.

The worker warns with their ids: `cancelled N apply run(s) started on other code, which no worker would run: <ids>. Apply again.` The next apply plans again from the data files. A change whose deploy was cancelled this way ends with the cancellation as its deploy's error. Applies queued before this release sit on the app's queue, outside the apply queue: upgrade with no apply queued.

## Unfinished runs

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

## Queue names

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. Sandbox runs had their own queue, `sanoma:<appName>:sandbox`, until they went on the app's; the warning names the runs left on it, and a sandbox run forked or resumed past its seed step fails at once, so start its scenario again or cancel it. On a local database, `pnpm db:down && pnpm db:up` resets it.
