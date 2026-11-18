---
title: Versions
description: "Every run is stamped with the application version of the worker that runs it, <appName>@<version>, and only a worker on that version recovers it after a restart."
sidebar:
  order: 5
---

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Versioning is automatic: the version is a hash of each workflow's name, the source of its `run` function, its operations and its input schema, which is DBOS's own scheme applied to the workflow code rather than to the runtime's registration wrapper (DBOS would otherwise see one identical function for every workflow and never change). The hash cannot see functions `run` calls that live elsewhere, op schemas, drivers or the policy: edit those with no run in flight, or restart on the old code first. To name a version instead (a git commit, say), set DBOS's `DBOS__APPVERSION` environment variable; it is prefixed with the app name the same way. A new version becomes the app's latest when it first starts, and runs queued without a version go to the latest; a worker started on an older version (a rollback) warns instead, unless started with `{ promote: true }`. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

## Runs that outlive their version

Three built-in workflows are the exception: a deploy restarts the worker on the merged code, a new version, and the `apply` and `change` runs that made the deploy have to outlive their version, as does a move between secret stores (`migrate-store`). Each run of a built-in workflow carries a hash of that workflow's own code (its `builtInCode` attribute: what the version hashes of the workflow, with the runtime's and DBOS's versions, never the company's workflows). A worker that starts as the app's latest version takes over the unfinished `apply`, `change` and `migrate-store` runs of other versions whose hash is its own, keeping each run's id, its completed steps and the messages it has not read yet (an approval decided, an event told while no worker ran). It says so in one line at `info`. Runs of the company's workflows stay on their version; so does a carried workflow's run whose hash differs, after an upgrade of the runtime.

An apply queued and never started is taken over whatever its hash, since it has no completed steps to replay: it runs on the new code in its place on the apply queue, so a push's deploy queued behind a change's still runs. An apply started on other code (the runtime upgraded under it) is cancelled instead, because no worker would ever run it and it would hold the apply queue's one place for good. The worker warns with their ids: `cancelled N apply run(s) started on other code, which no worker would run: <ids>. Apply again.` The next apply plans again from the data files. A change whose deploy was cancelled this way ends with the cancellation as its deploy's error. Applies queued before this release sit on the app's queue, outside the apply queue: upgrade with no apply queued.

## Unfinished runs

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

## Queue names

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. Sandbox runs had their own queue, `sanoma:<appName>:sandbox`, until they went on the app's; the warning names the runs left on it, and a sandbox run forked or resumed past its seed step fails at once, so start its scenario again or cancel it. On a local database, `pnpm db:down && pnpm db:up` resets it.
