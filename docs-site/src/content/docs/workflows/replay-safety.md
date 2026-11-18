---
title: Keeping workflows replay-safe
description: "A run is replayed after a restart by calling the function again and reading each step's result back, so workflows must do the same thing every time, and must reach vendors only through ctx so the policy sees every call."
sidebar:
  order: 12
---

A run is replayed after a restart by calling the function again and reading each step's result back, so workflows must do the same thing every time, and must reach vendors only through `ctx` so the policy sees every call. Two checks guard against getting that wrong by accident, on files under `workflows/` and `operations/` (a company operation's body runs inside the run, so it is held to the same rules, its `run` to a workflow's `run`'s). They are not a sandbox: they read the source, and code written to get around them can.

oxlint, with the rules this package ships in `oxlint.json`, refuses the clock (`Date.now()`, `new Date()` and `Date()`, through the plugin's rule `sanoma/date`, which allows `new Date(await ctx.now())`; `performance`), randomness (`Math.random`, `crypto`), the network (`fetch`, `WebSocket`), timers, `process`, `globalThis`, `Promise.all` and its kin (use `ctx.all`; nothing races), and imports of `sanoma/testing`, `sanoma/app`, `sanoma/workflows/describe`, `sanoma/workflows/fake`, `sanoma/workflows/plugin`, `sanoma/workflows/scenario`, `sanoma/workflows/scenarios`, `sanoma/workflows/wakeup-service`, `@sanoma-ai/connector-*/fake` and `@sanoma-ai/connector-*/driver`. From `sanoma/workflows` it allows only `defineOperation`, `defineWorkflow`, `mayDecide`, `errorCode`, `z`, `sanoma` ([the runtime's own operations](/workflows/built-ins/#the-runtimes-own-operations)) (which `sanoma` re-exports) and types (the list is `allowImportNames` in `oxlint.json`; the `sanoma` package's own `oxlint.json` allows the same names from `sanoma` and refuses its subpaths): the rest could start runs or approve the run's own approvals (`SanomaClient`, `startWorker`), forge the audit record (`jsonlLedger`, `memoryLedger`: a store keeps the first record per id) or read credentials. Each message names the `ctx` replacement. `sanoma check` runs it, through `sanoma/oxlint.json`, which carries these rules.

`describeConfig` (`sanoma/workflows/describe`) reads each workflow's file once, the one way the worker does, and lists on the workflow's entry, in `problems`, what oxlint can't express: imports come only from `sanoma/workflows` or `sanoma`, a `@sanoma-ai/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` directory (so not `../sanoma.config.ts`, which holds the config); no namespace import of either package; no dynamic `import()`; and no `instanceof` against `DriverError`, `SanomaError`, `PolicyDeniedError` or `RejectedError`. On a replay DBOS rethrows a serialized copy of an error, which is no instance of its class, so a branch on `instanceof` would go another way than the first time and the run's steps would fall out of step. Read `errorCode(err)` instead.

In each workflow's `run` it also lists what the run's graph could not show, the same problems that make the outline `{ error }` and `startWorker` refuse (see [Outline](/workflows/your-own-ui/#outline)): `ctx` used other than called directly or read for `ctx.runId` or `ctx.startedBy` (passed to a helper, aliased, destructured, or `run` taking it destructured); a call on `ctx` that is no operation or built-in (`ctx.ghost.post()`); `ctx.all` over members made elsewhere (write the list, or `items.map(…)`, in the call); a `ctx` call inside a function the outline does not read (one defined inside `run`, or a callback not passed to `ctx.all`, `.map`, `.forEach` or `.reduce`) or in a `finally`; and, in `run`, in a `finally` and in the callbacks that make `ctx` calls, a `return` before the end, a `throw` outside a `catch`, a `break` out of a loop or to a label, and `continue`; and a [step name](/workflows/built-ins/#step-names) that is not a literal or reads as an operation's id or `Sleep`, and two steps given one name. A function without `ctx` calls computes, and may do as it likes. Each message says what to write instead: inline the helper, use `if`/`else` around the rest, name the call. Each problem has its `line` and `column` in the entry's `file` (an unreadable file, or one that holds no workflow of the entry's name, is the outline's error at 1:1); `sanoma check` prints them, as `problemLine` does, and the app's startup warns of them. A test holds a repo to the same:

```ts
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import config from "../sanoma.config.ts";

it("has no problems", () => {
  const { problems, workflows } = describeConfig(config);
  expect([...problems, ...workflows.flatMap((wf) => wf.problems)]).toEqual([]);
});
```
