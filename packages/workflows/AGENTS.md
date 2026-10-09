# @sanoma/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. An oxlint config and `lintWorkflow` guard workflow and policy code against accidental non-determinism and accidental ways around the policy. They are lint, not a sandbox: code written to get around them can.

## Contents

| Path                         | What it is                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------- |
| [`src/`](src/AGENTS.md)      | The package source                                                               |
| [`test/`](test/AGENTS.md)    | Vitest tests, a shared harness and fixtures                                      |
| [`oxlint.json`](oxlint.json) | The oxlint config that guards workflow and policy code; shipped with the package |

## Usage

```sh
npm install @sanoma/workflows zod
```

A connector declares a vendor's operations: their inputs, outputs and effect. A workflow lists the operations it `uses`, and its `ctx` exposes those and nothing else.

```ts
import { defineConnector, defineWorkflow } from "@sanoma/workflows";
import { z } from "zod";

const shop = defineConnector("shop", {
  order: {
    get: { effect: "read", input: z.object({ id: z.string() }), output: z.object({ total: z.number() }) },
    refund: { effect: "money", input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
});

export default defineWorkflow({
  name: "refund",
  trigger: "manual",
  input: z.object({ id: z.string() }),
  uses: [shop.order.get, shop.order.refund, "approval"],
  run: async (ctx, { id }) => {
    const order = await ctx.shop.order.get({ id });
    // Covers the refund below, so the policy lets it through without asking again.
    await ctx.approval(`Refund ${order.total}`, { approver: "finance-lead", covers: [shop.order.refund] });
    return ctx.shop.order.refund({ id });
  },
});
```

A third argument says who the vendor is, so the app can show it: `defineConnector("shop", specs, { title: "Shop", logo: { svg, dark }, package, homepage })`. `logo.svg` is the vendor's mark as inline SVG markup, one `<svg>…</svg>` element (`defineConnector` refuses anything else, such as a file path or a URL), and `logo.dark` its variant for dark backgrounds, if it has one. The app shows a logo before each of the vendor's operations, in graphs and lists, and only ever as an image (`<img>` with a `data:` URL), where an SVG's scripts and external references never run or load. A vendor with no logo is shown by its operations' ids alone, as before. `package` is the connector's npm package name (`"@sanoma/connector-resend"`), which the app's Connectors page links to on npm. `homepage` is the connector package's `homepage` from its package.json: where its code and README are, as an https URL (`defineConnector` refuses anything else); the Connectors page links to it as the connector's source. A vendor whose operations are split over several connectors is described by the first connector's info, its package and homepage as well as its title and logo.

Drivers implement the operations and hold the credentials. A policy is checked before every operation call, and a ledger records what happened.

```ts
import { allow, approve, approvedFor, defineConfig, definePolicy, jsonlLedger } from "@sanoma/workflows";

const policy = definePolicy(
  ({ op, effect, run }) => {
    if (effect !== "money") return allow();
    // Approved by finance-lead for this operation: not any approval, and not one a workflow
    // addressed to someone else.
    return approvedFor(run.approvals, op.id, "finance-lead") ? allow() : approve("finance-lead");
  },
  { version: "2026-10-07" },
);

export default defineConfig({
  workflows: [refund],
  connectors: [shop],
  drivers,
  policy,
  ledger: jsonlLedger(".sanoma/ledger"),
  appName: "acme",
});
```

A config must name its policy and its ledger. `policy: allowAll` allows every operation call, and says so. `ledger: jsonlLedger(dir)` keeps the audit record in files the app and other processes read; `memoryLedger()` keeps it in this process only, for tests. `resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`), and the operations and drivers by id. It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver, two workflows with one name, no policy, no ledger. `startWorker`, `SanomaClient.connect` and `describeConfig` all call it, so they fail the same way. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

A policy returns `allow()`, `deny(reason)` (the run fails) or `approve(who)` (the run waits for that person, or for anyone in `{ group }`; see [Approvals](#approvals)). `allow(reasons)` and `deny(reason, reasons)` may add a list of reasons for whoever reads the ledger. The policy must decide the same way on every replay: no clock, randomness or network. What it sees is plain data, so a test can build one by hand, with `policyOpOf(op)` for the operation as the runtime passes it:

```ts
interface PolicyCall {
  op: { id: string; vendor: string; resource: string; name: string; effect: Effect }; // no schemas
  effect: Effect; // the same as op.effect
  target?: string; // the instance the call acts on, when the operation declares `target`
  input: unknown; // checked against the operation's schema
  actor: Principal; // who started the run
  run: { id: string; workflow: string; approvals: readonly ApprovalState[] };
}

const call: PolicyCall = {
  op: policyOpOf(shop.order.refund),
  effect: "money",
  input: { id: "ord_1" },
  actor: { id: "alice" },
  run: { id: "r1", workflow: "refund", approvals: [] },
};
expect(policy(call)).toEqual(approve("finance-lead"));
```

An operation names the instance it acts on with `target`, a function of its parsed input, so a policy can decide per post or per order rather than per operation. TypeScript types its input `any` there, so annotate it to have it checked:

```ts
const shop = defineConnector("shop", {
  order: {
    refund: {
      effect: "money",
      input: z.object({ id: z.string() }),
      output,
      target: ({ id }: { id: string }) => `order/${id}`,
    },
  },
});
```

A policy's answer is checked; anything else (`{ kind: "approve" }` with no approver, say) fails the run with a message naming the operation. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided (a policy's hold names the call it holds by its `op` and `opSeq`, the `seq` that call's own record has), each message an approval ignored (`approval.refused`: sent by someone who may not decide it, or not a decision), each sleep (`sleep.started` with `until`, when it ends in ms since the epoch: the time asked for, or for a duration, the time the sleep started plus the duration, as the runtime saw it; written for a time already past too), and how the run ended, in a JSONL file per run. A decision is recorded with its `reasons` and, for a policy from `definePolicy(fn, { version })`, its `policyVersion`. Every record carries `v: 1`, the `app` and the `actor`, and one written inside a `ctx.all` member its `group` (see [Built-ins](#built-ins)); an error is recorded as `{ code?, name, message }`, with `retryable` when the error says, the vendor's `status` and `vendorCode` only from a `DriverError`, and `data` only from the runtime's own errors (the operation, the approval, the input's issues), so an HTTP client's error that escapes a driver does not put the vendor's reply in the ledger. A ledger store's failed append is tried again up to three times; a store throws an error with `retryable: false` for a failure that would only repeat. When a call's record still cannot be written after the vendor replied, the call fails with "<op id> succeeded, but the ledger could not record it" and the run makes no further calls (`run_ended`), so a workflow that catches the failure cannot repeat the side effect unrecorded.

People are `Principal`s: `{ id, groups? }`. A run is started as one and a decision is sent as one:

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice", groups: ["support"] } });
const approval = await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }); // status: "approved"
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`startedBy` is required. `start(workflow, input, { startedBy, runId })` with a `runId` makes a retried start idempotent: an id that exists returns that run when the workflow, the input (as JSON) and `startedBy` match, and is refused with `invalid_input`, naming what differs, when they do not. Of two starts racing with one new id, the first stands and the second is answered the same way. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`, `run_ended`, `run_running`: `client.result` timed out with the run still going, `sandbox_busy`: another [sandbox run](#scenarios-and-sandbox-runs) is using the fakes) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)`, from `@sanoma/workflows/describe`, returns the same config as plain JSON (its version, each workflow's input as JSON Schema, the operations it may call and its [outline](#outline), each operation's effect and contract: its input as a caller sends it, `io: "input"`, and its output as parsed, `io: "output"`), and each vendor's title, logo, package and homepage (`vendors`, by vendor id, the logo as `data:image/svg+xml` URLs), which is what a UI renders from.

The worker, the client and the app find Postgres at the config's `databaseUrl`, else the `SANOMA_DATABASE_URL` environment variable, else `postgresql://postgres:dbos@localhost:5433/sanoma`, the database `pnpm db:up` starts from this repo's docker compose file. Set one of the first two anywhere but on your own machine.

### Approvals

An approval comes from the workflow (`ctx.approval(title, { approver, covers?, links?, details? })`) or from the policy holding a call (`approve(approver, { title?, covers? })`). Each is in `run.approvals` with its `status`, so a later policy call can see it.

`covers` says which operations an approval stands for, as op ids in the approval's state. A policy hold covers the operation it held, plus any `covers` the policy adds; a workflow's approval covers the operations it names, or none. The idiomatic policy check is `approvedFor(run.approvals, op.id, approver)`: approved, covering this operation, and addressed to the approver the policy would name. The last part matters: a workflow can request an approval covering any operation from anyone it names, so a check on `covers` alone would let a workflow launder a sign-off through its own `ctx.approval`. Covers name operations, not inputs: an approval that covers `shop.order.refund` covers every later refund call in the run. A policy that needs one approval per call compares `a.input` too.

The approver is a person's id (`"finance-lead"`), or `{ group: "finance" }` for anyone whose principal lists that group in `groups`. A group's name is not a person: `{ id: "finance" }` is not in the group `finance`. `mayDecide(approval, principal)` is the check the run and the client both use. A policy hold's default title is `<op id> needs <approver>`, the approver shown as `group finance` for a group.

A policy hold's approval also carries the held call: its `op`, its parsed `input`, and `opSeq`, the ledger `seq` of the call's `op.called` record, so a UI can show the hold on the call it held.

`client.decide(runId, { decision, by, note? }, approvalId?, { timeoutSeconds? })` refuses without sending when the approval is decided already (`already_decided`), when the run has finished, failed or been cancelled (`run_ended`: no run would read the decision), when there is nothing pending (`no_pending_approval`, `run_not_found`) or when `by` may not decide (`not_approver`, naming the approver or group). Otherwise it sends the decision and waits for the run to read it, then returns the approval as decided: the run publishes it on the event `decisionEventOf(approvalId)`. If another decision reached the run first (someone else's, or another of yours), it throws `already_decided` with who decided and how: each message carries an `id` (a new one unless `message.id` is given), and the approval records the one it was decided with as `decidedWith`. The id is also the send's idempotency key, scoped to the approval, so a retried send queues one message. If the run does not read the decision within `timeoutSeconds` (30 by default), for instance because no worker is running, it returns the approval still `pending`; the decision stays queued and the run reads it when it next runs. The run checks the sender again and records anything it refuses as `approval.refused`; when it refuses this decision, `decide` throws `not_approver` rather than returning the approval pending.

### Calls run one at a time

A run's ctx calls run one at a time, in program order. Even inside `Promise.all`, each call waits for the one before it to settle, so two calls a policy holds for approval are asked for one after the other. DBOS matches a replayed call to its recorded result by the order calls reach it, so calls left to race would replay out of step. A call that fails rejects its caller. The calls queued after it still run only if the workflow catches the failure and goes on; otherwise the body has ended, and each queued call is refused with `run_ended` (the run has ended, so the call is never made) instead of reaching its vendor, an approver or a sleep. Write calls one after another, as the workflow means them, and a fan-out with `ctx.all`.

### Built-ins

A workflow gets these on `ctx` by listing them in `uses`, next to its operations: `"approval"` (see [Approvals](#approvals)), `"sleep"` and `"all"`. `describeConfig` lists them as each workflow's `builtins`.

`ctx.sleep({ until })` takes an ISO 8601 date-time with an offset (`2026-10-07T09:00:00Z`) or epoch milliseconds, and a time already past does not wait; `ctx.sleep({ minutes: 5 })` takes a duration from `ms`, `seconds`, `minutes`, `hours` and `days`, none negative. A request it can't read fails the run with `invalid_input`, as does an operation input its schema refuses. Each sleep writes a `sleep.started` record before it waits, with `until`: the time asked for, or for a duration, the time the sleep started plus the duration, as the runtime saw it.

`ctx.all([() => …, () => …])` declares a fan-out: work that could go in any order, such as one post per network. It calls the members one after another, in array order, each awaited before the next starts, and returns their outputs in that order, each typed as its member's. It adds no concurrency: calls through `ctx` run one at a time anyway, and `ctx.all` says what belongs together, so the ledger and a graph of the run can show it. Every record written while a member runs (its operation calls, its approvals, its sleeps) carries `group: { id, index, size }`: `id` is `all:<seq>`, the ledger `seq` the run's next record would take when `ctx.all` began (so the same on a replay), `index` the member's position and `size` the member count. Records outside a group have no `group`. The first member that throws stops the group: its error is rethrown as it is, and the members after it never run. A `ctx.all` inside a member fails with `invalid_input` (`ctx.all cannot be nested`), as does one started while another is still running (`a ctx.all is already running: await it before the next`) and an argument that is not a list of functions; an empty list returns `[]` and writes nothing.

```ts
const [post, broadcast] = await ctx.all([
  () => ctx.bluesky.post.create({ text }),
  () => ctx.resend.broadcast.send({ id: email.id }),
]);
const comments = await ctx.all(threads.map((id) => () => ctx.forum.comments.list({ id })));
```

The lint refuses `Promise.all` and `Promise.allSettled` in workflows, pointing at `ctx.all`, and `Promise.race` and `Promise.any`: calls through `ctx` run one at a time, so nothing races; pick one call, or sleep and then check.

### Drivers

A driver implements a connector's operations with `defineDriver(connector, { resource: { name: (input, call) => … } })`, typed by the connector's schemas. `call` carries `idempotencyKey`, the same on every retry and replay of one call: pass it to the vendor (or dedupe on it) so a crash between the vendor's reply and the checkpoint does not repeat the side effect. A driver reads its credentials when it is called, never from the config.

When the vendor says no, throw a `DriverError(message, { retryable, status?, vendorCode? })`. An operation declared `idempotent` is tried up to three times (after 1 and 2 seconds) unless the error says `retryable: false` or the reply fails the output schema; any other operation is tried once. When the tries run out, the run fails with the last try's error, not a wrapper: for a `DriverError`, `errorCode(err)` is `"driver_failed"` and the ledger records the vendor's message, status and code. Anything else a driver throws (a `TypeError`, a plain `Error`) fails the run as it is, with no code.

### Secrets

Never put a secret in a workflow's input or an operation's input or output. They are persisted verbatim: DBOS keeps every step's input and output in Postgres, the ledger records each call's input and output, an approval a policy asks for carries the held call's input, and the app shows all of it to anyone who can reach it. A driver reads its credentials when it is called (from the environment or a secret store), and an operation that creates a secret (an API key, a password reset link) returns a reference to where it is stored, not the secret.

### Versions

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Versioning is automatic: the version is a hash of each workflow's name, the source of its `run` function, its operations and its input schema, which is DBOS's own scheme applied to the workflow code rather than to the runtime's registration wrapper (DBOS would otherwise see one identical function for every workflow and never change). The hash cannot see functions `run` calls that live elsewhere, op schemas, drivers or the policy: edit those with no run in flight, or restart on the old code first. To name a version instead (a git commit, say), set DBOS's `DBOS__APPVERSION` environment variable; it is prefixed with the app name the same way. A new version becomes the app's latest when it first starts, and runs queued without a version go to the latest; a worker started on an older version (a rollback) warns instead, unless started with `{ promote: true }`. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. On a local database, `pnpm db:down && pnpm db:up` resets it.

## Keeping workflows replay-safe

A run is replayed after a restart by calling the function again and reading each step's result back, so workflows and policies must do the same thing every time, and must reach vendors only through `ctx` so the policy sees every call. Two checks guard against getting that wrong by accident, on files under `workflows/` and `policies/`. They are not a sandbox: they read the source, and code written to get around them can.

oxlint, with the rules this package ships in `oxlint.json`, refuses the clock (`Date`, `performance`), randomness (`Math.random`, `crypto`), the network (`fetch`, `WebSocket`), timers, `process`, `globalThis`, `Promise.all` and its kin (use `ctx.all`; nothing races), and imports of `@sanoma/testing`, `@sanoma/app`, `@sanoma/workflows/describe`, `@sanoma/workflows/scenario`, `@sanoma/connector-*/fake` and `@sanoma/connector-*/driver`. From `@sanoma/workflows` it allows only `defineWorkflow`, `definePolicy`, `allow`, `deny`, `approve`, `approvedFor`, `allowAll`, `mayDecide`, `errorCode` and types (the list is `allowImportNames` in `oxlint.json`): the rest could start runs or approve the run's own approvals (`SanomaClient`, `startWorker`), forge the audit record (`jsonlLedger`, `memoryLedger`: a store keeps the first record per id) or read credentials. Each message names the `ctx` replacement. Extend it from your `.oxlintrc.json` by its path: oxlint resolves `extends` as a file, not a package name, so `@sanoma/workflows/oxlint` would not load. The `workflows/**` and `policies/**` globs resolve against your config:

```json
{
  "extends": ["./node_modules/@sanoma/workflows/oxlint.json"]
}
```

`lintWorkflow` from `@sanoma/workflows/lint` checks the same names from `@sanoma/workflows`, read from that `oxlint.json`, and what oxlint can't express: imports come only from `@sanoma/workflows`, a `@sanoma/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` or `policies/` directory (so not `../sanoma.config.ts`, which holds the drivers); no namespace import of `@sanoma/workflows`; no dynamic `import()`; and no `instanceof` against `DriverError`, `SanomaError`, `PolicyDeniedError` or `RejectedError`. On a replay DBOS rethrows a serialized copy of an error, which is no instance of its class, so a branch on `instanceof` would go another way than the first time and the run's steps would fall out of step. Read `errorCode(err)` instead. Run it over those directories in a test:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow } from "@sanoma/workflows/lint";
import { expect, it } from "vitest";

const files = ["workflows", "policies"].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f)),
);

it.each(files)("%s has no problems", (file) => {
  expect(lintWorkflow(readFileSync(file, "utf8"), file)).toEqual([]);
});
```

`@sanoma/workflows/lint` is a separate entry so the runtime never loads its parser.

## Fakes for tests

`@sanoma/workflows/fake` exports `defineFake(connector, { initial, ops }, { file?, calls? })`, which builds an in-memory vendor for a connector: `ops` implements every operation against the fake's state, typed by the connector as `defineDriver` is, and the fake adds what a real vendor does around them (a repeated idempotency key gets the first reply and changes nothing) and faults a test can inject (`failNext`, `loseReply`, `rateLimit`, `hold`). The connectors' own fakes (`@sanoma/connector-ghost/fake` and the others) are built with it, and `@sanoma/testing` re-exports them. It is a separate entry so the runtime carries no test tooling, and the lint refuses it in workflow files.

## Scenarios and sandbox runs

A scenario is a Gherkin feature file that says what a sandbox run starts from, how its approvals are decided and what it should do. A sandbox run is a real run of a workflow, under the same policy and approvals, that calls fake vendors instead of the drivers, so a workflow can be tried before it touches anything. Put the fakes and a directory of `.feature` files in the config:

```ts
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { fakeResend } from "@sanoma/connector-resend/fake";

export default defineConfig({
  workflows: [announce],
  connectors: [ghost, resend, bluesky],
  drivers,
  fakes: [fakeGhost(), fakeResend(), fakeBluesky()],
  scenarios: new URL("./scenarios/", import.meta.url),
  policy,
  ledger: jsonlLedger(".sanoma/ledger"),
});
```

`fakes` are `defineFake` fakes, one per vendor (`resolveConfig` refuses two for one); each implements its vendor's operations for sandbox runs. `scenarios` must be a `file:` URL (`resolveConfig` refuses anything else); a directory that does not exist has no scenarios. Every `.feature` file under it is read; each must hold at least one scenario, and each scenario's name must be unique across them. Each row of a `Scenario Outline`'s examples is a scenario of its own, named from the outline's title; rows whose names come out the same get their line appended, such as `Launch (line 12)`.

```gherkin
Feature: Announce a launch

  Scenario: Launch on time
    Given a post titled "Old news" exists
    And bluesky.post.create fails once
    When announce runs with
      """
      { "title": "Acme Pro", "launchAt": "2030-01-01T09:00:00Z" }
      """
    And "Review launch copy" is approved by marketing-lead with note "ship it"
    Then a post titled "Acme Pro" is created
    And post "post_0002" is published
    And "Acme Pro https://blog.example.test/acme-pro/" is posted to Bluesky
    And resend.broadcast.send was called with
      """
      { "id": "bc_0001" }
      """
    And the run succeeds
```

The steps, as [Cucumber expressions](https://github.com/cucumber/cucumber-expressions) (`{op}` is an operation id, `{workflow}` a workflow name, `{who}` a person's id, `{string}` a quoted string; `And` and `But` take the keyword before them):

| Keyword | Step                                                                                 | What it does                                                                                |
| ------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Given   | `{op} was called with` and a JSON doc string or a two-column table (`name \| value`) | Seeds the fake: calls the operation through it before the run                               |
| Given   | `{op} fails once`, `{op} is rate limited once`, `{op} loses its reply once`          | Injects the fault into the operation's next call (`failNext`, `rateLimit`, `loseReply`)     |
| When    | `{workflow} runs with` and a JSON doc string or a two-column table (`name \| value`) | The workflow the scenario runs, and its input                                               |
| When    | `{workflow} runs`                                                                    | The same, with the input made up                                                            |
| Any     | `{string} is approved by {who}`, `… with note {string}`, and the `rejected` forms    | How the approval with that title (or id, such as `approval-2`) is decided                   |
| Then    | `{op} was called with` and a JSON doc string or a two-column table                   | Expects a call whose input has at least these fields                                        |
| Then    | `{op} was called`, `{op} was not called`                                             | Expects a call to the operation, or none                                                    |
| Then    | `the run succeeds`, `the run fails`, `the run fails with {string}`                   | Expects the run to finish, or to fail (with that error code, such as `"approval_rejected"`) |

Each scenario has exactly one `When … runs`. An operation can add its own steps with `phrases` in its spec: `{ given: "a post titled {title} exists", expect: "a post titled {title} is created" }`. Each `{name}` is a field of the operation's input (a phrase naming another is a configuration error); it matches what `{string}` does (a quoted string) or one word, and is read as a table cell is. A field may have any name, even one a parameter type has (`op`, `string`, `int`): the phrase reads it as the field. A `given` phrase seeds the fake as `was called with` does, and an `expect` phrase (for `Then` steps) expects a call with those fields. `describeConfig` lists them as an operation's `phrases`.

A doc string is a JSON object. A table cell, and a phrase's field, is read as text when its field takes text, else as JSON (a number, `true`, a list): `| title | 123 |` is the text `"123"` for a string field, and `| count | 5 |` the number 5 for a number field. Every field a doc string or a table names must be one the input has (the error lists those it has), and its value one the field takes; a value it takes neither as text nor as JSON, such as `yes` for a boolean, is an error. A `Then` checks each field it names this way, not the whole input.

Input the scenario leaves out is made up from the schema with [zod-schema-faker](https://github.com/soc221b/zod-schema-faker), seeded from the scenario's name, so one scenario always makes up the same values; it is then parsed by the schema. A step no rule matches, or more than one, an unknown operation, workflow or field, a value its field does not take, a missing or second `When` and a doc string that is not JSON are errors naming the file and line; the first lists every step there is, each operation's phrases under its id.

`@sanoma/workflows/scenario` (server-side only; the lint refuses it in workflow files) reads and checks them:

- `loadScenarios(resolveConfig(config))` returns `{ scenarios, errors }`: every scenario, and an error for each file that does not parse or name used twice. It reads the config's `ops`, `workflows` and `scenarios`. `parseFeature(text, file, scope)` reads one file, and throws.
- `check(scenario, records)` checks each expectation against a run's ledger records and returns `{ step, ok, detail? }` for each: a call matches when its parsed input contains the expected input (every field, at every depth); a call is an `op.called` record without an `error`, so one the policy denied, an approver rejected or the vendor failed for good was attempted, not made (`was not called` passes, and a failed `was called` lists the attempts in its `detail`); and an outcome is read from `run.finished` or `run.failed` (`ok: false`, "run not ended", before either).
- `drive(client, runId, scenario, { timeoutMs? })` decides the run's approvals as the scenario says until the run ends, and returns its `RunSummary`. Each pending approval takes the decision naming its title or id, else the next decision left that names no approval of the run: none it has asked for, and none in `scenario.approvals`, the titles its workflow's code asks for where they are string literals (read from its [outline](#outline)). So `"the first one"` is decided in order, but a decision for `"Final check"` is never spent on the approval before it. An approval with no such decision throws, naming the decisions left. Each decision waits for the run to read it until the timeout; a worker that has not read it by then throws `run_running`, as does a run still going. `by` is a person's id, so a scenario cannot decide an approval addressed to a group.

Start a sandbox run with `client.start(workflow, input, { startedBy, sandbox: "<scenario name>" })`. The input is the caller's (a scenario's own is `scenario.input`). The worker then:

- seeds the fakes from the scenario, once, in a step named `sandbox:seed`, so a replay never seeds twice: it resets every fake, calls each `Given` operation through its fake, injects the faults, and empties the call log, so the log holds the run's calls only. It records `scenario.seeded` (the scenario, and each seed's operation, input and output) right after `run.started`. A scenario that does not exist, or runs another workflow, fails the run with `invalid_input`.
- calls the fakes, never a driver, under the same policy and approvals as a live run.
- does not wait on `ctx.sleep`: it still records `sleep.started` with the real `until`, and goes straight on.
- runs one sandbox run at a time, since they share the fakes: another started while one has not ended fails with `sandbox_busy`.

`RunSummary.sandbox` names the scenario a sandbox run was seeded from (kept in DBOS's `attributes` for the run). Reusing a run id with another `sandbox`, or none, is `invalid_input`, as with another input.

## Building your own UI

`@sanoma/app` is one UI over a config; another (a Slack bot, an internal tool) can be built on the same pieces, which the package exports for that:

- `describeConfig(config)` and its types (`ConfigDescription`, `WorkflowEntry`, `OpEntry`), from `@sanoma/workflows/describe`: what to render, as plain JSON, with each workflow's outline. It is a separate entry so the worker never loads the parser the outline uses, and the lint refuses it in workflow files. `resolveConfig(config)` returns the checked config as a `ResolvedConfig`, with the operations and drivers by id and the workflows by name; `isOp(x)` tells an operation from a built-in in a workflow's `uses`.
- `SanomaClient`: start runs, list them, read a run's ledger and approvals, and decide approvals, with the checks described above.
- `APPROVALS_EVENT` and `decisionEventOf(approvalId)`: the DBOS events a run publishes its approvals and each decision on, for a UI that reads DBOS directly. `ApprovalMessage` is the zod schema of a decision as a run reads it. `RunArgs` is what a run receives: its input, `startedBy` and, for a sandbox run, its scenario as `sandbox`.
- `mayDecide(approval, principal)` and `approverLabel(approver)`: who may decide, and how to name them, the same way the run does. `isEnded(status)` and `ENDED_STATUSES`: the run statuses that read no more decisions.
- Errors: `errorCode(err)` for the code to branch on, `errorMessage(err)` for the text of anything thrown, `invalidInput(what, issues)` to build an `invalid_input` error from zod issues (`InputIssue` is one issue, without symbols in its path), and the classes `SanomaError`, `PolicyDeniedError`, `RejectedError` and `DriverError`. Read codes with `errorCode`, never `instanceof`.
- `@sanoma/workflows/shared` exports `mayDecide`, `approverLabel`, `errorMessage`, `isEnded`, `ENDED_STATUSES` and the `RunStatus` type with nothing else: no DBOS or Node imports, so a browser bundle can use them. The main entry exports them too.
- `LedgerRecord` and `LedgerStore` for the audit record (`LedgerBody` is a record without the fields every record carries, and `LedgerGroup` a record's `ctx.all` tag), `jsonlLedger(dir)` and `memoryLedger()` to keep it, and `RUNTIME_VERSION`, this package's version as the runtime reports it.

### Outline

`outlineWorkflow(wf)`, from `@sanoma/workflows/describe`, reads a workflow's shape from the source of its `run` function, for drawing it before it runs. `describeConfig` returns it as each workflow's `outline`:

```ts
import { outlineWorkflow } from "@sanoma/workflows/describe";

outlineWorkflow(announce);
// { nodes: [{ kind: "op", id: "ghost.post.create", span: [913, 974] }, …, { kind: "approval", title: "Review launch copy", span: […] }, …], file: "/…/workflows/announce.ts" }
```

It parses `run` with oxc-parser (TypeScript in a repo, JavaScript once built) and lists, in the order they run, the calls made on `run`'s first parameter, whatever it is named: operations (`op`, with a `*` for a computed segment such as `ctx[vendor].comments.list`), approvals (with the title, when it is a string literal), sleeps, and `ctx.all`: `all` with one branch per member of an array literal, or for anything else, such as `ids.map(…)`, `each` with the callback's calls as its `body`. Around them it shows loops and `.map`, `.forEach` and `.reduce` callbacks as `repeat`, and `if`, `switch`, `?:`, `&&`, `||` and `??` as `branch`: one case per arm that makes calls, plus one empty case for the way past them when there is one (an arm without calls, an `if` without `else`, a `switch` without `default`, the right side of `&&` not run). It is a reading of the body, not a guarantee: it does not read the functions `run` calls, whether defined outside `run` (a helper that takes `ctx`) or inside it, only callbacks passed to `ctx.all`, `.map`, `.forEach` and `.reduce`; and it cannot see how many times a loop runs, which arm is taken, or a `ctx` passed around under another name. It returns `{ error }` when the source cannot be read or parsed, or when `run` destructures its `ctx` parameter.

`defineWorkflow` records the file it is called from as the workflow's `file`, by itself; nothing passes it. The outline is read from that file when it can be read and holds the workflow (an object literal with its `name`, as a string literal, and a `run` function), and then says so: `{ nodes, file }`. Otherwise it is read from the text of `run` itself, and `{ nodes, fallback }` says why the file was not used (the workflow has no file, or the file could not be read or parsed, or holds no workflow by that name). `describeConfig` puts the text it was read from beside it, as the workflow's `source`, with `\n` line endings either way; a server can keep that from its clients, since it is a whole file. Each node's `span` is where its code is in `source`, as UTF-16 offsets (a string index, and what CodeMirror counts): the call, the `ctx.all(…)`, the loop or `.map(…)` call, or the whole `if` / `else` chain, `switch`, `?:` or `&&`.

Status: early (0.x). The API may change between minor versions.

TODO: redact fields a schema marks `.meta({ sensitive: true })` from the ledger, the approvals event and DBOS's step records, so a secret passed by mistake is not kept.

License: Apache-2.0.
