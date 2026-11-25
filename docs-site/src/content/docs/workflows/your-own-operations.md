---
title: Your own operations
description: "Group several calls into a company operation and use it from a workflow or a site."
sidebar:
  order: 6
---

Give a recurring sequence of calls a name. For example, a `quote` operation can read the company’s rates and return a price. Define it with `defineOperation` from `sanoma` and export it as the default from a file in `operations/`. For an [app](/start/apps/#apps), use `apps/<app>/operations/`.

```ts
// operations/quote.ts
import { defineOperation, z } from "sanoma";
import { rates } from "../resources/data.ts";

export default defineOperation({
  name: "quote",
  description: "What some hours of a service cost",
  input: z.object({ service: z.string(), hours: z.number() }),
  output: z.object({ total: z.number() }),
  uses: [rates.get],
  run: async (ctx, { service, hours }) => {
    const rate = await ctx.data.rates.get({ key: service });
    return { total: (rate?.record.hourly ?? 0) * hours };
  },
});
```

Start the operation name with a lowercase letter, followed by letters or digits. For the `quote` example, the generated ID is `operations.quote.run`, or `operations.<app>.quote.run` inside an app. The vendor name `operations` is reserved. Supply a Zod `output` schema if you want Sanoma to check what `run` returns.

Sanoma loads default-exported operations from `operations/` alongside workflows. It treats a file with no default export as a helper. A default export of another kind produces an error such as `operations/odd.ts's default export is not an operation: …`. In a repo created before operations were supported, add `"operations"` and `"apps/*/operations"` to `include` in `tsconfig.json` so `tsc` checks those files.

`uses` lists connectors' and collections' operations only, and its `ctx` holds those and nothing else. An approval, a sleep and `ctx.all` are a workflow's, around operations, and so is another company operation: `defineOperation` refuses each (`defineOperation("quote"): uses lists operations only; …`). Its effect is the strongest of what it uses, in the order read, write, publish, send, money, access, and `read` with none; it is idempotent when all of them are.

Its body is held to a workflow body's rules: the [lint](/reference/files/#the-lint) checks each file of `operations/` as it checks a workflow's (its imports, and what the outline cannot draw), and the worker reads the operation's outline from its file when it starts, refusing to start without it. A file of `operations/` may import `resources/data.ts` and the files beside it; a workflow may import the files of `operations/`, the root's or an app's.

## In a workflow

Add the operation to the workflow’s `uses` list alongside connector operations. Call it on `ctx` as shown here.

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

An app's operation is `ctx.operations.<app>.<name>.run`. In a run the operation is one call: the policy decides it as it decides any operation (its action is `operations.quote.run`, in the group of its effect), a hold waits in the Inbox, and the ledger records it once, with its input and output. Its body runs inside the run. Each call it makes is a call of the run, with its own saved steps, decision and record: a retry repeats only the call that failed, a replay reuses what the calls answered, and a call the policy holds waits in the Inbox as any call does.

The policy sees such a call with the operation's id where it sees a run's workflow (`PolicyCall.run.workflow`).

The operation takes its `seq` first and records its own `op.called` once its body has ended. Each record of a call inside carries `within`, the operation call's `seq`, and its `node` is under the operation's: `<operation's node>.0.<its node in the operation's outline>`. Two passes of a loop, or two `ctx.all` members, that call the operation keep their calls apart by `within`. `describeConfig` lists a company operation among the `ops`, with what a workflow's entry has besides: `app`, `ops` (what it uses), `file`, `outline`, `problems` and `source`.

The version hashes each operation's body, input schema and uses, as it hashes a workflow's: a change to an operation starts a new version. A [scenario](/testing/scenarios/) runs the operation's calls against the fakes, as any call: a fake for each operation it uses, none for the operation itself.

## From a page

A page calls an operation directly, in one request, with no run to poll: `api.operations.quote.run({ service, hours })` (`api.operations.<app>.<name>.run` for an app's), answering its output. The generated `api` types that output from `output` for the kinds [`generateApi` lists](/workflows/your-own-ui/), so a page reads it with no cast: `const { total } = await api.operations.quote.run({ service, hours });`. The rest (a date, a transform's result and the like) stays `unknown`, as does the output of an operation that declares no `output`, which a page narrows itself.

It may when every operation it uses may be called directly (`isDirect`: a collection's operations and a vendor's reads); one that uses a vendor's write is a workflow's step, which `sanoma check` says of a page that calls it, naming what keeps it from one ("which a page may not call directly, since it calls ghost.post.create: start a workflow that uses it"), and so does a direct call's refusal, and the generated `api` leaves it out.

Its body runs on the server, as the person on the page ([direct calls](/workflows/direct-calls/)), so the Worker build refuses a file of `operations/` that imports what workerd does not have, as it refuses a site's, and the lint refuses `sanoma/invoices/pdf` in one: render a PDF in a workflow.

The policy decides the call as the person, its action `operations.quote.run`, then decides each call the body makes as a call in a run, with the operation's id where a run's workflow is. A deny of the operation, or of a call inside, throws `policy_denied`. A hold of either holds the whole operation: the call becomes a run of the built-in `call` workflow, which runs the operation once approved, and the page gets `approval_pending` with its run.

A write made before a call inside was held or denied stands. When a call inside is held, the approved run makes the whole operation again, the writes made before the hold included: write the same values to the same keys (a save of the whole record by its key is that), and do not derive a key or a value from `ctx.now()` in an operation a page calls, since the run's time is not the page's call's.

An operation that only reads records nothing; one that writes records its own `op.called` (seq 0) and each write inside within it, so the same request id answers what was recorded without writing again.

A visitor of a public site calls one only where a `permit` names the operation (`action == Sanoma::Action::"operations.quote.run"`). On a site with no `login` every visitor is `anonymous`, who is in no group, so a permit for the group `visitors` does not cover them: `permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"operations.quote.run", resource);` does. `sanoma check` prints the permit to add for each call no permit could allow.

The calls inside are then allowed as a run's, the forbids still holding, and the operations it uses stay out of the visitor's direct reach. [`sanoma demo`](/sites/demos/) bundles an operation a page calls, and runs its calls on the fakes.

## In the app

The [Connectors](/start/the-app/) page lists the company's operations under **Yours**, above the installed connectors: each one's name, id and effect, what it does, where it can run ("Pages and workflows" when everything it uses may be called directly, as [from a page](#from-a-page); "Workflows only" otherwise) and how many workflows and pages use it.

Each opens its own page at `/connectors/operations/<name>` (`crm.score` for an app's): who may call it and from where, with a link to Permissions ([policies](/policies/policies/)); what it takes and returns; what it calls, each linking to its collection or connector; its file, from the company's root, with its code; and what uses it: workflows, site files and other operations.

In a workflow's graph, its outline and a run's alike, an operation is a box named by its step, its id, effect and (in a run) its decision along the top, holding the calls inside it in their order. A run's box is the operation call's state: active while its body runs, then its record's. A call a policy holds inside it waits in its box. Clicking the box shows the operation, its file linking to its page; clicking a call inside it shows that call's record. The calls inside have no place in the workflow's file: theirs is the operation's, shown on its page.

On the Permissions page, the calls inside an operation are rows under its row, one step further in, wherever its row is: under a workflow that uses it, or among the operations called directly. Its row links to its page. A collection's and a connector's **Used by** lists the operations that call them beside the workflows, and a workflow counts the vendors its operations call as its own. A change's files group `operations/` as **Operations**, beside the workflows.
