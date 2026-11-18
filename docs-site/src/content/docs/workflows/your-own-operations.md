---
title: Your own operations
description: "An operation of the company's own: a few calls under one name, which a workflow calls as one step."
sidebar:
  order: 6
---

An operation of the company's own puts a few calls under one name: a quote read from the rates, a customer looked up then saved. `defineOperation`, from `sanoma`, declares one in its own file of `operations/` (or an [app's](/start/apps/#apps) `apps/<app>/operations/`), its default export:

```ts
// operations/quote.ts
import { defineOperation, z } from "sanoma";
import { rates } from "../resources/data.ts";

export default defineOperation({
  name: "quote",
  description: "What some hours of a service cost",
  input: z.object({ service: z.string(), hours: z.number() }),
  uses: [rates.get],
  run: async (ctx, { service, hours }) => {
    const rate = await ctx.data.rates.get({ key: service });
    return { total: (rate?.record.hourly ?? 0) * hours };
  },
});
```

Its name is a lowercase letter, then letters and digits, as a collection's. Its id is `operations.quote.run` (`operations.<app>.quote.run` in an app's folder): an operation of the vendor `operations`, which no connector may take. `output`, a zod schema, checks what `run` returns when it is given. `sanoma` adds every operation the files of `operations/` export by default when it loads the config, as it adds the workflows; a file with no default export is a helper, and one whose default export is something else is refused (`operations/odd.ts's default export is not an operation: …`).

`uses` lists connectors' and collections' operations only, and its `ctx` holds those and nothing else. An approval, a sleep and `ctx.all` are a workflow's, around operations, and so is another company operation: `defineOperation` refuses each (`defineOperation("quote"): uses lists operations only; …`). Its effect is the strongest of what it uses, in the order read, write, publish, send, money, access, and `read` with none; it is idempotent when all of them are. Its body is held to a workflow body's rules: the [lint](/reference/files/#the-lint) checks each file of `operations/` as it checks a workflow's (its imports, and what the outline cannot draw), and the worker reads the operation's outline from its file when it starts, refusing to start without it. A file of `operations/` may import `resources/data.ts` and the files beside it; a workflow may import the files of `operations/`, the root's or an app's.

## In a workflow

A workflow names the operation in `uses`, as it names a connector's, and calls it on `ctx`:

```ts
import quote from "../operations/quote.ts";

export default defineWorkflow({
  name: "estimate",
  trigger: "manual",
  input: z.object({ service: z.string(), hours: z.number() }),
  uses: [quote],
  run: async (ctx, input) => ctx.operations.quote.run(input),
});
```

An app's operation is `ctx.operations.<app>.<name>.run`. In a run the operation is one call: the policy decides it as it decides any operation (its action is `operations.quote.run`, in the group of its effect), a hold waits in the Inbox, and the ledger records it once, with its input and output. Its body runs inside the run. Each call it makes is a call of the run, with its own saved steps, decision and record: a retry repeats only the call that failed, a replay reuses what the calls answered, and a call the policy holds waits in the Inbox as any call does. The policy sees such a call with the operation's id where it sees a run's workflow (`PolicyCall.run.workflow`).

The operation takes its `seq` first and records its own `op.called` once its body has ended. Each record of a call inside carries `within`, the operation call's `seq`, and its `node` is under the operation's: `<operation's node>.0.<its node in the operation's outline>`. Two passes of a loop, or two `ctx.all` members, that call the operation keep their calls apart by `within`. `describeConfig` lists a company operation among the `ops`, with what a workflow's entry has besides: `app`, `ops` (what it uses), `file`, `outline`, `problems` and `source`.

The version hashes each operation's body, input schema and uses, as it hashes a workflow's: a change to an operation starts a new version. A [scenario](/testing/scenarios/) runs the operation's calls against the fakes, as any call: a fake for each operation it uses, none for the operation itself.

A page does not call an operation yet: it is a workflow's step.
