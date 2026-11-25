---
title: Keeping workflows replay-safe
description: "Write workflows a worker can replay after a restart and diagnose the checks that reject unsafe code."
sidebar:
  order: 12
---

After a restart, the worker calls the workflow function again and reads back the result of each completed step. The function must therefore reach the same steps in the same order. Make vendor calls through `ctx` so the policy can evaluate each one.

The linter and config checks inspect source in `workflows/` and `operations/`. A company operation’s `run` executes inside the workflow, so the same rules apply. These checks catch accidental mistakes. They do not isolate untrusted code.

## What the lint refuses

`sanoma check` runs oxlint with `sanoma/oxlint.json`. Its rules identify the unsupported API and name its `ctx` replacement where applicable.

| Source of variation | What the linter checks |
| --- | --- |
| Time | `Date.now()`, `new Date()`, `Date()`, and `performance`. The `sanoma/date` rule allows `new Date(await ctx.now())`. |
| Randomness, network, and process state | `Math.random`, `crypto`, `fetch`, `WebSocket`, timers, `process`, and `globalThis`. |
| Concurrency | `Promise.all` and related combinators. Use `ctx.all` to group steps. Workflows cannot race steps. |

Workflow files can import types and the following names from `sanoma/workflows` or the `sanoma` root entry: `defineOperation`, `defineWorkflow`, `mayDecide`, `errorCode`, `z`, and `sanoma` for [runtime operations](/workflows/built-ins/#the-runtimes-own-operations). The `allowImportNames` list lives in `oxlint.json`. The `sanoma` package’s own lint config also restricts subpath imports.

Keep worker, test, and driver APIs outside workflows. Restricted imports include `sanoma/testing`, `sanoma/app`, `sanoma/workflows/describe`, `sanoma/workflows/fake`, `sanoma/workflows/plugin`, `sanoma/workflows/scenario`, `sanoma/workflows/scenarios`, `sanoma/workflows/wakeup-service`, `@sanoma-ai/connector-*/fake`, and `@sanoma-ai/connector-*/driver`. This keeps run control (`SanomaClient`, `startWorker`), credentials, and audit stores (`jsonlLedger`, `memoryLedger`, which keep the first record for an ID) outside the workflow’s authority.

## Checking a config

`describeConfig` (`sanoma/workflows/describe`) reads each workflow's file once, the one way the worker does, and lists on the workflow's entry, in `problems`, what oxlint can't express: imports come only from `sanoma/workflows` or `sanoma`, a `@sanoma-ai/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` directory (so not `../sanoma.config.ts`, which holds the config); no namespace import of either package; no dynamic `import()`; and no `instanceof` against `DriverError`, `SanomaError`, `PolicyDeniedError` or `RejectedError`.

On a replay DBOS rethrows a serialized copy of an error, which is no instance of its class, so a branch on `instanceof` would go another way than the first time and the run's steps would fall out of step. Read `errorCode(err)` instead.

The checker reports constructs it cannot represent in a workflow’s [outline](/workflows/your-own-ui/#outline). The outline then contains `{ error }` and `startWorker` refuses the workflow. Check these parts of `run`:

- **Context access.** Call `ctx` methods directly or read `ctx.runId` and `ctx.startedBy`. Aliasing, passing, or destructuring `ctx` prevents analysis. Each call must name an operation or built-in. For example, `ctx.ghost.post()` names neither.
- **Groups and callbacks.** Write the member list or `items.map(…)` inside `ctx.all`. A helper defined inside `run`, an unsupported callback, or a `finally` block cannot make context calls. The checker recognizes callbacks passed to `ctx.all`, `.map`, `.forEach`, and `.reduce`.
- **Control flow.** In `run`, in a `finally` block, and in callbacks that make context calls, the checker rejects an early `return`, a `throw` outside a `catch`, a `break` out of a loop or to a label, and `continue`.
- **Step names.** Use a unique literal for each [step name](/workflows/built-ins/#step-names). Operation IDs and `Sleep` are reserved.

A function without `ctx` calls computes, and may do as it likes. Each message says what to write instead: inline the helper, use `if`/`else` around the rest, name the call. Each problem has its `line` and `column` in the entry's `file` (an unreadable file, or one that holds no workflow of the entry's name, is the outline's error at 1:1); `sanoma check` prints them, as `problemLine` does, and the app's startup warns of them. A test holds a repo to the same:

```ts
import { describeConfig } from "sanoma/workflows/describe";
import { expect, it } from "vitest";
import config from "../sanoma.config.ts";

it("has no problems", () => {
  const { problems, workflows } = describeConfig(config);
  expect([...problems, ...workflows.flatMap((wf) => wf.problems)]).toEqual([]);
});
```
