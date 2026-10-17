# @sanoma-ai/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. An oxlint config and `lintWorkflow` guard workflow and policy code against accidental non-determinism and accidental ways around the policy. They are lint, not a sandbox: code written to get around them can.

## Usage

```sh
npm install @sanoma-ai/workflows zod
```

A company repo usually installs [`sanoma`](https://www.npmjs.com/package/sanoma) instead, whose bin runs the worker and the app over its `sanoma.config.ts` and re-exports what a workflow imports from this package; `startWorker` and `startApp` remain for a custom host.

A connector declares a vendor's operations: their inputs, outputs and effect. A workflow lists the operations it `uses`, and its `ctx` exposes those and nothing else.

```ts
import { defineConnector, defineWorkflow } from "@sanoma-ai/workflows";
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

A third argument says who the vendor is, so the app can show it: `defineConnector("shop", specs, { title: "Shop", logo: { svg, dark }, package, homepage })`. `logo.svg` is the vendor's mark as inline SVG markup, one `<svg>…</svg>` element (`defineConnector` refuses anything else, such as a file path or a URL), and `logo.dark` its variant for dark backgrounds, if it has one. The app shows a logo before each of the vendor's operations, in graphs and lists, and only ever as an image (`<img>` with a `data:` URL), where an SVG's scripts and external references never run or load. A vendor with no logo is shown by its operations' ids alone, as before. `package` is the connector's npm package name (`"@sanoma-ai/connector-resend"`), which the app's Connectors page links to on npm. `homepage` is the connector package's `homepage` from its package.json: where its code and README are, as an https URL (`defineConnector` refuses anything else); the Connectors page links to it as the connector's source. A vendor whose operations are split over several connectors is described by the first connector's info, its package and homepage as well as its title and logo.

A [driver](#drivers) implements the operations and holds the credentials, and a [fake](#fakes-for-tests) stands in for the vendor in [sandbox runs](#scenarios-and-sandbox-runs). A connector package attaches both to the connector it exports, with `withSetup` (and its [steps](#steps-a-connector-ships) for Gherkin tests, as `steps`), so a config names the connector alone:

```ts
// The connector package's root, such as @acme/connector-shop.
export const shop = withSetup(defineConnector("shop", specs, info), {
  driver: shopDriver, // made once per resolved config
  fake: fakeShop, // made once per sandbox run: each has its own
});
```

`withSetup` lays what it is given over what the connector already carries, and keeps it on the connector's vendor record, so a spread copy of the connector keeps it too. A config that needs a driver made otherwise (another bridge, other options) swaps the driver and keeps the fake: `withSetup(github, { driver: () => githubDriver({ bridge }) })`. It is for connector packages and configs, not for workflows, which the lint does not let import it. Both are optional: a connector without a driver declares its operations and implements none, so a workflow using one is refused; a connector without a fake has none for sandbox runs, which the app's connector page says.

A policy is checked before every operation call, and a ledger records what happened.

```ts
import { allow, approve, approvedFor, defineConfig, definePolicy } from "@sanoma-ai/workflows";

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
  policy,
});
```

That is the whole config; the rest is convention, from its `root` (`defineConfig`'s call site's directory, or `root` where that is not the source's, as in a bundle). Two conventions give what a config no longer says:

- **The app's name** is the `name` in `<root>/package.json`, kept whole (`@acme/ops`), when that file exists and names one; otherwise, and for a config with no root, it is `"sanoma"`. Only the root's own file counts, never one above it, so a parent project's name never becomes the app's; a `package.json` that is not JSON is refused, naming it. The name scopes the app's runs, queues and versions in its database.
- **The [scenarios](#scenarios-and-sandbox-runs)** are `<root>/scenarios/` when that is a directory; otherwise the config has none.

The [data files](#data-files) are `resources/` in the root. `ledger` and `databaseUrl` are the only other fields. `drivers`, `fakes`, `appName` and `scenarios` are typed `never` on `SanomaConfig`, each deprecated with where it went, so the compiler and the editor say so; an untyped config that still names `drivers` or `fakes` is refused at run time rather than run live on what it no longer reads.

A config must name its policy. `policy: allowAll` allows every operation call, and says so. The audit record goes to the ledger, by default `postgresLedger(databaseUrl)` on the config's database (see [Ledger](#ledger)); `ledger: jsonlLedger(dir)` keeps it in files instead, and `memoryLedger()` in this process only, for tests. `resolveConfig(config)` checks a config and derives what the runtime uses from it: the app name, database, version and queue (`sanoma:<appName>`, for every run, [sandbox runs](#scenarios-and-sandbox-runs) included), the operations by id, the driver each vendor's connector attaches, made once for the resolution (`driversByVendor`, in `connectors` order, and their functions by operation id, `drivers`), the makers of their fakes (`fakes`, by vendor), the scenarios directory, and the config's `ledger` when it gives one; it opens nothing and reads no file but the root's `package.json` and whether `scenarios/` is a directory. It throws, with one message, whatever the worker would refuse: a workflow or driver naming an operation the `connectors` don't declare, a workflow redeclaring an operation with another effect, an operation with no driver (`` `shop.order.refund` has no driver: the connector package must attach one ``), two different drivers or fakes for one vendor, two workflows with one name, no policy, a `ledger` that is not a store, a `drivers` or `fakes` an untyped config still names. `startWorker`, `SanomaClient.connect` and `describeConfig` all call it, so they fail the same way. It adds the built-in [`drift`](#drift) and [`apply`](#apply) workflows when the connectors declare resource types. The worker takes each operation's effect, schemas and retry setting from `connectors`, never from the workflow.

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

A policy's answer is checked; anything else (`{ kind: "approve" }` with no approver, say) fails the run with a message naming the operation. The ledger gets one record for the start of the run, each operation call with its decision and the vendor's reply, each approval requested and decided (a policy's hold names the call it holds by its `op` and `opSeq`, the `seq` that call's own record has), each message an approval ignored (`approval.refused`: sent by someone who may not decide it, or not a decision), each sleep (`sleep.started` with `until`, when it ends in ms since the epoch: the time asked for, or for a duration, the time the sleep started plus the duration, as the runtime saw it; written for a time already past too), and how the run ended, in a JSONL file per run. A decision is recorded with its `reasons` and, for a policy from `definePolicy(fn, { version })`, its `policyVersion`. Every record carries `v: 1`, the `app` and the `actor`, and one written inside a `ctx.all` member its `group` (see [Built-ins](#built-ins)); each call's record (`op.called`, `approval.requested`, `sleep.started`) carries its step's `name` (see [Step names](#step-names)); an error is recorded as `{ code?, name, message }`, with `retryable` when the error says, the vendor's `status` and `vendorCode` only from a `DriverError`, and `data` only from the runtime's own errors (the operation, the approval, the input's issues), so an HTTP client's error that escapes a driver does not put the vendor's reply in the ledger. A ledger store's failed append is tried again up to three times; a store throws an error with `retryable: false` for a failure that would only repeat. When a call's record still cannot be written after the vendor replied, the call fails with "<op id> succeeded, but the ledger could not record it" and the run makes no further calls (`run_ended`), so a workflow that catches the failure cannot repeat the side effect unrecorded.

People are `Principal`s: `{ id, groups? }`. A run is started as one and a decision is sent as one:

```ts
const client = await SanomaClient.connect(config);
const runId = await client.start(refund, { id: "ord_1" }, { startedBy: { id: "alice", groups: ["support"] } });
const approval = await client.decide(runId, { decision: "approve", by: { id: "finance-lead" } }); // status: "approved"
const run = await client.run(runId); // run.status: "queued" | "running" | "waiting" | "finished" | "failed" | "cancelled"
```

`workflow` is a definition or the name of one in the config's `workflows` (`client.start("refund", …)`); a name the config does not have is refused with `invalid_input`, naming the ones it has. `startedBy` is required. `start(workflow, input, { startedBy, runId })` with a `runId` makes a retried start idempotent: an id that exists returns that run when the workflow, the input (as JSON) and `startedBy` match, and is refused with `invalid_input`, naming what differs, when they do not. Of two starts racing with one new id, the first stands and the second is answered the same way. Errors the runtime and the client throw carry a `code` (`policy_denied`, `approval_rejected`, `not_approver`, `no_pending_approval`, `already_decided`, `run_not_found`, `driver_failed`, `invalid_input`, `run_ended`, `run_running`: `client.result` timed out with the run still going) and `data`. Read it with `errorCode(err)`, not `instanceof`: a run's error comes back from the database as a copy, so `errorCode(await client.result(runId).catch((e) => e))` is `"policy_denied"` for a denied call.

`startWorker(config, { logLevel })` runs workflows and recovers interrupted runs. `SanomaClient` starts runs, lists them, records approval decisions and reads a run's ledger. `describeConfig(config)`, from `@sanoma-ai/workflows/describe`, returns the same config as plain JSON (its version, each workflow's input as JSON Schema, the operations it may call and its [outline](#outline), each operation's effect and contract: its input as a caller sends it, `io: "input"`, and its output as parsed, `io: "output"`), each vendor's title, logo, package and homepage and whether its connector attaches a fake (`vendors`, by vendor id, the logo as `data:image/svg+xml` URLs), the resource types (`resourceTypes`, see [Resources](#resources)), and the resources the data files declare, each with its binding, the lockfile's orphans and what is wrong in them (`resources`, `orphans` and `problems`, see [Data files](#data-files); a workflow's file's problems are on its entry, beside its `file` and `outline`), which is what a UI renders from.

The worker, the client and the app find Postgres at the config's `databaseUrl`, else the `SANOMA_DATABASE_URL` environment variable, else `postgresql://postgres:dbos@localhost:5433/sanoma`, the database `pnpm db:up` starts from this repo's docker compose file. Set one of the first two anywhere but on your own machine.

### Ledger

The ledger is the audit record of a run: who started it, every operation call with the policy's decision, every approval, and how it ended, as `LedgerRecord`s in `seq` order. `client.ledger(runId)` reads it, and the app's run page shows it. Three stores keep it, each a `LedgerStore` (`append`, `read`, and `close` for one that holds a connection), and a config picks one with `ledger`:

- `postgresLedger(databaseUrl)`, the default when `ledger` is not set: one table, `sanoma_ledger`, in the config's database beside DBOS's own, which the worker, the app and other processes then share without sharing a disk. The table is made on first use, and the database with it when it is not there (as a worker's launch makes it), so the app may read before any worker has run. The worker and the client (so the app) each make their own store and close it with themselves (`stop`, `client.close()`); `close()` ends its pool for good. A store the config gives is the config's to close: the runtime never closes it.
- `jsonlLedger(dir)`: `<dir>/<runId>.jsonl`, one record per line, for a ledger on disk or in a repo.
- `memoryLedger()`: this process only, for tests.

Every store keeps the first record of an id: a run replayed after a restart writes its records again, with the same ids, and the store skips them (warning when a later one differs). A failed `append` is tried again three times, unless the store says the failure is final (`retryable: false`): a record that is not JSON, a corrupt file.

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

`ctx.all([() => …, () => …])` declares a fan-out: work that could go in any order, such as one post per network. It calls the members one after another, in array order, each awaited before the next starts, and returns their outputs in that order, each typed as its member's. It adds no concurrency: calls through `ctx` run one at a time anyway, and `ctx.all` says what belongs together, so the ledger and a graph of the run can show it. Every record written while a member runs (its operation calls, its approvals, its sleeps) carries `group: { id, index, size, node }`: `id` is `all:<seq>`, the ledger `seq` the run's next record would take when `ctx.all` began (so the same on a replay), `index` the member's position, `size` the member count and `node` the `ctx.all` call's [outline](#outline) node. Records outside a group have no `group`. The first member that throws stops the group: its error is rethrown as it is, and the members after it never run. A `ctx.all` inside a member fails with `invalid_input` (`ctx.all cannot be nested`), as does one started while another is still running (`a ctx.all is already running: await it before the next`) and an argument that is not a list of functions; an empty list returns `[]` and writes nothing.

```ts
const [post, broadcast] = await ctx.all([
  () => ctx.bluesky.post.create({ text }),
  () => ctx.resend.broadcast.send({ id: email.id }),
]);
const comments = await ctx.all(threads.map((id) => () => ctx.forum.comments.list({ id })));
```

The lint refuses `Promise.all` and `Promise.allSettled` in workflows, pointing at `ctx.all`, and `Promise.race` and `Promise.any`: calls through `ctx` run one at a time, so nothing races; pick one call, or sleep and then check.

#### Step names

Every call is a step with a name, which a test and the graph name it by: `ctx.github.repository.import(input, { name: "Import the repository" })` and `ctx.sleep({ days: 1 }, { name: "Wait a day" })` give one, and an approval is named by its title. Without one, a call is named by its operation's id (`github.repository.import`), a sleep `Sleep` (`DEFAULT_SLEEP_NAME`, exported from the main entry and `@sanoma-ai/workflows/shared`). A name given, and an approval's title, is a string literal or a top-level `const` of the file holding one, so the outline reads it; it is one step's only (`two steps of this workflow are named "Draft"`), and a name given may not be what unnamed calls are called, an operation's id (three dotted words) or `Sleep`, so a name in a test means one call. Unnamed calls may share their default: one operation in two arms of an `if`, a retry in a `catch`, two sleeps. A call in a loop is one step, however often it runs. The outline resolves each call's name (`name` on `op`, `sleep` and `approval` nodes: the name given, the title, the operation's id or `Sleep`), except a call with a computed segment (`ctx[vendor].post.create`) and no name, which the operation it calls names in a run, and an approval whose title is no literal, which its title names in a run. The ledger has the name of every step (`name` on `op.called`, `sleep.started` and `approval.requested`, where a policy hold's is the held call's); records written before steps had names have none. `StepOptions` is the options' type.

### Drivers

A driver implements a connector's operations with `defineDriver(connector, { resource: { name: (input, call) => … } })`, typed by the connector's schemas, and its package attaches it to the connector it exports (`withSetup`). `call` carries `idempotencyKey`, the same on every retry and replay of one call: pass it to the vendor (or dedupe on it) so a crash between the vendor's reply and the checkpoint does not repeat the side effect. It carries `secrets` too, the store `secret()` markers name (see [Secrets](#secrets)). A driver reads its credentials when it is called, never from the config, and declares them (see [Credentials](#credentials)).

When the vendor says no, throw a `DriverError(message, { retryable, status?, vendorCode? })`. An operation declared `idempotent` is tried up to three times (after 1 and 2 seconds) unless the error says `retryable: false` or the reply fails the output schema; any other operation is tried once. When the tries run out, the run fails with the last try's error, not a wrapper: for a `DriverError`, `errorCode(err)` is `"driver_failed"` and the ledger records the vendor's message, status and code. Anything else a driver throws (a `TypeError`, a plain `Error`) fails the run as it is, with no code.

### Credentials

A driver reads its credentials from the environment when it is called, and declares them in `defineDriver`'s third argument: `defineDriver(acme, impl, { env: z.object({ ACME_API_KEY: z.string().describe("an API key, from Settings, API keys"), ACME_REGION: z.enum(["us", "eu"]).optional().describe("the region; default us") }) })`. Each key is a variable's name, its `.describe()` the one-line manual, `.optional()` marks one that may be unset. The driver reads the raw environment, so `.default()` and `.transform()` are not applied to what it reads (use `.optional()` and name the default in `.describe()`), and a `.refine()` or `.superRefine()` on the `z.object` is not evaluated, only its fields. Only the declared names are read, an empty value counts as unset, and a value is never kept: each variable is set, missing or invalid, with the schema's reason.

The environment stays the only interface a driver sees, but a value need not come from a file. Locally, set values live in the `sanoma_credentials` table in the config's database (`databaseUrl`), which the runtime creates on first use, encrypted with AES-256-GCM under `SANOMA_SECRETS_KEY`, bound to its name (a value moved to another row does not decrypt) (32 random bytes, base64; `sanoma` writes one to `.env` when there is none): storing a value without the key fails, naming it. A value stored before encryption is read as it is, and encrypted on its next write. Set one from the app's connector page, or with `client.setCredential("GHOST_ADMIN_API_KEY", value, { by: "alice" })`, and delete it with `client.clearCredential(name, { by })`; `client.credentials()` gives each vendor's statuses, each with its `source` (`environment` or `stored`) and, for a stored one, who set it and when. A name no driver declares, or a value its schema refuses, is refused with the reason, never the value. `client.setSecret(name, value, { by })` stores a value under any variable's name, declared or not (a data file's `secret()`, or the app's own, such as its GitHub App's keys), checking a declared one as `setCredential` does, and `client.secrets(names)` reads values back for server code, the environment's first, with their `source` and who stored them. `startWorker` loads the stored values of the declared variables its environment leaves unset into `process.env` and listens for changes, so a value set or cleared is live without a restart: drivers read `process.env` when they are called. A worker whose listener drops reconnects and loads them again. A variable the process environment sets wins over a stored one, always. The worker starts whether or not every variable is there: it prints one line naming each vendor with a variable missing (and not optional) or invalid, `sanoma: 2 of 5 connectors not configured yet: ghost, resend; set their variables on the connector pages or in the environment` (`unconfigured` names them too; `quiet: true` prints nothing, as `runScenarios` does, its runs calling only the fakes). A call to that vendor then fails, as the call's own failure: a `DriverError` that is not retried, saying why, `<vendor> is not configured: <NAME> (<description>), <NAME> is invalid: <why>; set it on the connector page` (or `set in the environment`, when an invalid value is there: the environment wins over a stored value), checked against the environment at the moment of the call, so a value set on the connector page (or in `process.env`) takes effect on the next call, with no restart. The call's `op.called` record carries it, and the run fails with it like any other final driver failure. `startApp` starts the same way, and its connector pages show and set them.

The values are plain text in the local database: the same exposure as a `.env` file on the same disk. Keep `.env` (`node --env-file-if-exists=.env`) for the bootstrap values a worker needs before it can read the database: the database URL, the bridge binary, the port. A value never reaches the ledger or the description; see [Secrets](#secrets) for why one must never be an input either.

### Resources

A resource type is a kind of vendor object a company declares the state of, such as a GitHub repository. `defineResource` declares one, and derives its operations, so the runtime knows only operations:

```ts
import { defineConnector, defineResource } from "@sanoma-ai/workflows";

export const repository = defineResource({
  vendor: "github",
  type: "repository",
  title: "Repository",
  identity: "name", // optional, with `find`: how `find` makes the identity, for people
  schema, // a z.object: the fields a read returns, and a data file declares (less the vendor-owned ones)
  fields: { immutable: [], vendorOwned: ["html_url", "node_id"], writeOnly: [], unordered: ["topics"] }, // and `references`, below
  find: ({ name }) => name, // optional: the import id that finds a declared resource before it is bound
  bindingId: (state) => String(state.node_id), // optional: the stable id a binding keeps; default `String(state.id)`
  normalize, // optional: the part of a state a drift check compares; default `compareDeclared`
  writable: true, // optional: apply may change its objects (the change operations, below)
  stateless: true, // optional: its objects hold no data, so apply makes one gone again without asking
});
export const github = defineConnector("github", { repository });
```

A resource type is a connector's group under its own `type`; `defineConnector` refuses one of another vendor, or under another key, or on a connector without `info.package` (data files import the types from `<package>/resources`), and keeps the list on the connector, beside its vendor info. Its operations are `<vendor>.<type>.import` (`{ id }`, an identity or a binding id) and `<vendor>.<type>.read` (`{ id, state?, handle? }`, a state from an earlier call), both answering `{ id, gone: true }` when the vendor has no such object and `{ id, gone: false, state, handle? }` when it has, both effect `read`, idempotent, with the id as the policy's `target`. "Missing" is part of the contract: the driver decides it, so a caller never parses a vendor's error for it. A driver implements them like any other. `handle` is the driver's own data about the object, opaque to everyone else, passed back unchanged (an OpenTofu driver keeps the provider's private data and state version in it); the operations declare it `opaque`, so the ledger records it as `"<handle>"`, never its bytes. Any operation may name such fields (`opaque` in its spec).

A `writable` type has four change operations besides, which the built-in apply workflow (`APPLY_WORKFLOW`, `"apply"`, a name a config's own workflow may not take) calls and no other: `resolveConfig` refuses a workflow whose `uses` names `create`, `update` or `delete` of a declared type, and a run of any other workflow is refused the call. `plan` (effect `read`, idempotent) takes `{ id?, state?, handle?, desired? }` (no `id` for a create, no `desired` for a delete) and returns `{ action, planned?, unknown, replace }`: `none`, `create`, `update`, `replace` or `delete`, the new state without write-only fields, the dotted paths known only after apply, and those whose change replaces the object. `create` (effect `write`, `target` `new:<vendor>.<type>`) takes `{ desired }` and returns `{ id, state, handle? }`, `id` its binding id; `update` takes `{ id, state?, handle?, desired, expect? }` and returns the same, refusing with a `DriverError` whose `vendorCode` is `plan_changed` when the fresh plan's `action` or `replace` differs from `expect`; `delete` (idempotent) takes `{ id, state?, handle? }` and returns `{ id, gone: true }`, an object already gone included. `desired` may hold secret markers at write-only fields, which the driver resolves (`resolveSecrets`) just before the vendor call (`plan` stores no generated secret: one not stored yet gets a throwaway value); no output holds a write-only value.

Calling the type declares one resource, which is what a data file does: `repository({ name: "sanoma" })` returns a frozen `Declared`, `{ vendor: "github", type: "repository", name: "sanoma", desired: { name: "sanoma" }, refs: {} }`, branded with its `<vendor>.<type>` under the `DECLARED` symbol. It refuses a field the schema does not have, a field the vendor owns (unless `identity` names it), a value the schema rejects, or an empty identity. A type without `find` (Stripe's, whose objects Stripe names) declares resources without a `name`: they are found only by their bindings ([below](#bindings)).

A field may name another declared resource where the type's `fields.references` says so, by dotted path, with the type it names and, in `by`, the fields of that resource the vendor may hold there instead: GitHub's `branch_protection` has `{ repository_id: { type: "github.repository", by: ["name", "node_id"] } }`, since GitHub holds a rule's repository by its node id. So `branch_protection({ repository_id: site, pattern: "main" })` takes the repository `site`. It stands for that resource's `name`: `desired` holds `repository_id: "website"`, which the schema and `find` (the rule is `website:main`) read, and a drift check takes any of the repository's `by` values, read in the same run, as that name; and `refs` says where a resource was named, `{ repository_id: "github.repository:website" }` (a list item's path has its index, `teams.0`). Anywhere else, or of another type, a resource is refused, and the constructor's type (`Declaring`) says the same, so the editor marks it first.

Only declared fields are compared for drift, as CloudFormation does: `compareDeclared(fields, state, desired)` keeps the fields `desired` declares, minus `vendorOwned` and `writeOnly` ones, picking objects field by field, list items against the declared item at the same index, and the items of an `unordered` list (a set) against what any declared item declares, sorted, so a set is compared as a multiset whatever order the vendor returns it in. A drift check compares `normalize(actual, desired)` with `normalize(desired, desired)`, leaf by leaf: `diffDeclared(resource, state, desired, accept?)` returns each declared field that differs, `{ path, desired, actual }`, where `accept` gives, by a reference's path, the values that stand for the resource it names. `withoutWriteOnly(fields, desired)` drops write-only values from a declaration, keeping a secret's marker, which names a stored value and holds none. So a field left out is never drift, which covers attributes an OpenTofu provider marks `computed` and `optional` (GitHub's `etag`, `topics`): they are the user's to set, so not `vendorOwned`, but the vendor fills them in when nobody does.

`describeConfig` lists the resource types as `resourceTypes`, each `{ id: "<vendor>.<type>", vendor, type, title, identity, fields, schema, ops }`: `schema` is its state as JSON Schema, with `$id` `sanoma:resource-type/<id>`, which its operations' contracts `$ref` rather than repeat. `@sanoma-ai/workflows/shared` exports the `Resource`, `ResourceSpec`, `ResourceFields`, `References`, `FieldReference`, `Declared`, `Declaring`, `DeclaredResource` and `ResourceProblem` types.

### Data files

A company declares the resources it wants in TypeScript data files under `resources/` beside its config, `resources/<area>/<file>.ts`, as its workflows are in `workflows/`. A data file holds plain values and references only, so Sanoma reads it without running it:

```ts
// resources/identity/github.ts
import { github } from "@sanoma-ai/connector-github/resources";

export const website = github.repository({ name: "website", visibility: "public", has_wiki: false });

export const websiteMain = github.branch_protection({
  repository_id: website, // a reference: stands for the repository's name
  pattern: "main",
  enforce_admins: true,
});

export default [website, websiteMain];
```

Another data file names `website` by importing it: `import { website } from "./github.ts"`.

What a data file may hold: named imports, of a connector's constructors from its `<package>/resources` entry (exported under the vendor's id), of resources from other `.ts` data files in `resources/`, and of `secret` from `sanoma/resources` (or `@sanoma-ai/workflows/resources`); `export const <name> = <vendor>.<type>({ … })`, one resource per statement and each name once, whose fields are strings (and template literals without `${}`), numbers, booleans, null, objects, arrays and, where the type's `fields.references` allows one, names of resources the file declares or imports, and, where the type's `fields.writeOnly` lists the field, `secret("NAME")` or `secret("NAME", { generate: true })` with literal arguments (see [Secrets](#secrets)); and `export default [a, b]`, the file's resources. Nothing else: no other calls, `new`, functions, spreads, computed keys, member access (`site.name`: name `site`), `process`, `undefined` (leave the field out) or type assertions. Each refusal says what to write instead.

The data files are found from the config's root: `defineConfig` records the file it is called from as the config's `file`, and `resolveConfig` gives its directory as `root`. A config bundled into one file sets `root` itself. A config with neither has no data files, and says so, rather than guess the working directory.

`readDataFiles(root, connectors)`, from `@sanoma-ai/workflows/describe`, reads every regular `.ts` file under `<root>/resources` (but `*.test.ts`, `*.d.ts` and `node_modules`), parsing it with oxc-parser and never importing it. A constructors import must be exactly a connector's `<info.package>/resources`, matched among the config's `connectors`; each resource is checked by calling its type, as running the file would, with each resource it names given as that resource. It returns `{ resources, bindings, orphans, problems }`: one `DeclaredResource` per `export const`, by file and then in file order, less any with a problem and any that names one, and the problems, by file, line and column:

```ts
interface DeclaredResource {
  id: string; // "<file>#<export>", the file relative to the root: "resources/identity/github.ts#websiteMain"
  file: string; // the file, as `id` names it: "resources/identity/github.ts"
  vendor: string; // "github"
  type: string; // "branch_protection"
  name: string; // what people call it: its identity, else its export's name: "website:main"
  identity?: string; // the import id that finds it unbound, from `find`: "website:main"
  binding?: string; // the id of the object the lockfile binds it to: "BPR_kwDOabc123"
  span: readonly [start: number, end: number]; // its `export const`, as UTF-16 offsets into the file
  desired: Record<string, unknown>; // its fields as its type checked them: { repository_id: "website", … }
  refs: Record<string, string>; // where it names a resource, to that resource's id: { repository_id: "resources/identity/github.ts#website" }
}

interface ResourceProblem {
  file?: string; // "resources/identity/github.ts"; absent, with line and column, when the config has no root
  line?: number;
  column?: number;
  message: string;
}
```

A problem is anything outside the subset, a constructors import of no connector in the config or a data file that is not one, a type the connector does not declare, a value the type refuses (a resource where it takes none among them), a reference cycle, or two resources of one type with one identity, and, from the lockfile ([below](#bindings)), a lockfile that is not JSON or not bindings, a binding of another type than its declaration's, or two declarations bound to one object. `describeConfig` lists both, as `resources` and `problems` (and the lockfile's `orphans`), so the app starts with the resources it could read and shows what is wrong in the rest. `readResources(config)` is the strict reading, for a test or CI: it returns the resources, or throws one error listing every problem at `file:line:column`.

#### Bindings

Which vendor object a declaration means lives in a lockfile beside the data files, `resources/sanoma.lock.json` (`LOCKFILE`), not in the declaration, as `package-lock.json` is beside `package.json`: data files hold intent only, so an edit to a field cannot point a declaration at another object, copying a declaration copies no binding, and a rename is an update. Only apply writes it; it is committed.

```jsonc
{
  "resources/identity/github.ts#website": { "type": "github.repository", "id": "R_kgDOabc123" },
  "resources/billing/stripe.ts#pro": { "type": "stripe.product", "id": "prod_Rx2" },
}
```

`readDataFiles` joins each declaration to its binding by its key, `<file>#<export>`, as `binding`, returns the lockfile's `bindings`, and lists as `orphans` (`{ key, type, id }`) the bindings no data file declares. A missing lockfile binds nothing. `@sanoma-ai/workflows/describe` exports `readLockfile(root)` (`{ bindings, problems }`), `serializeLockfile(bindings)` (keys sorted, two-space JSON, a trailing newline), `writeLockfile(root, bindings)` (whole or not at all: written beside it, then renamed), and `diffLockfiles(before, after)`, each change a `Rebind`: `{ key, type, kind: "bind" | "rebind" | "unbind", from?, to? }`.

oxlint holds `resources/**` to the subset with the rule `sanoma/data-file`, an oxlint JS plugin the package's `oxlint.json` loads from `dist/plugin.js`, so extending it (see [Keeping workflows replay-safe](#keeping-workflows-replay-safe)) covers data files as well; it does not know the config, so whether a connector, type or value is known is the reader's to say, in `describeConfig(config).problems`, which `sanoma check` prints.

Sanoma writes data files too, from `@sanoma-ai/workflows/describe`. `setFields(text, exportName, fields, options)` returns the file's text with fields of one resource set, by dotted path as a drift report names them (`{ has_wiki: true, "metadata.owner": "ops" }`; a field the declaration lacks is added): only that `export const` changes, formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter), and every other byte of the file stays as it was. It refuses a resource the file does not declare, a path through a value that is not an object or a list, and a value that is or holds a reference (a person changes those); a path whose segments name a field with a dot in its key (`metadata: { "app.owner": … }`) finds that field. `renderDataFile({ imports, exports }, options)` renders a whole new file, which `readDataFile` reads back as given (what it returns renders the file again, less its comments); a reference is a `Reference`, and a secret's marker is written as `secret("NAME")` (or with `{ generate: true }`), the file then importing `secret` from `"sanoma/resources"` (`setFields` adds that import after the file's own when it sets one). `formatOptions(root)` reads the options from `<root>/.oxfmtrc.json`, oxfmt's defaults without one. oxfmt is a dependency of this package, loaded only when a file is written.

### Drift

`drift` is a built-in workflow: `resolveConfig` adds it to every config whose connectors declare resource types, so the worker runs it, `describeConfig` lists it (its entry has `builtin: true`, a label) and it starts like any other workflow, with the input `{}`. A config's own workflow may not take its name. It `uses` the `import` of each resource type that has a driver, so its version moves with the connectors and drivers, not with the data files, and it is held to the same lint as any workflow: every vendor call goes through `ctx`, so the policy sees each as effect `read` and the ledger records it.

```ts
const runId = await client.drift({ startedBy: { id: "alice" } }); // start(drift, {}, …)
const report = await client.driftReport(runId); // waits for it, as `result` does
// { startedAt, finishedAt, problems: [], resources: [{ id, type, vendor, name, binding, status: "drifted", fields: [{ path: "has_wiki", desired: false, actual: true }] }, …] }
```

The run reads the data files and the lockfile itself, in its first step (`drift:data-files`, recorded, so a replay checks the same list): its input is `{}`, and any other is refused, so no caller can hand it other resources. The step records each resource without its write-only values, and the files' problems, which the report carries (`problems`; a file with problems contributes no resources, as in `describeConfig`). The worker loads the reader only then. Then the run imports each resource by its binding, else by its identity, one vendor call each (none for a resource with neither), in the files' order (every run imports: no state is kept between runs yet), and compares the declared fields with `diffDeclared` (above), a reference against the state of the resource it names from the same run. Each resource's `status` is `clean`, `drifted` (with `fields`, each leaf that differs: `{ path, desired, actual }`, a list item's path with its index, a list whose length changed or an `unordered` one whole), `gone` (the import of its binding says so), `absent` (it is not bound; `found` is the binding id of the object its identity found, if any, which apply may bind it to) or `error` (with `error`: the vendor's error, a policy denial, or no driver for its type); one resource's failure does not stop the others, but a failure that ends the run (`isRunControlError`: DBOS cancelling or stopping it) does. `client.drift` throws `invalid_input` when the connectors declare no resource types; `client.driftReport(runId)` throws `invalid_input` for another workflow's run. `DriftReport`, `DriftResult`, `DriftField` and `DriftStatus` are the report's types, also in `@sanoma-ai/workflows/shared`; `client.runs({ workflow: "drift" })` lists drift runs.

A host's revision is drift too (see [Hosts](#hosts)): the run resolves its ref with the built-in `sanoma.source.resolve`, and a host whose state runs another commit is `drifted`, with a field at its `revision` path (`desired` the commit the ref names now).

### Apply

`apply` is the built-in workflow that makes the vendors match the data files, beside `drift` and listed the same way (`builtin: true`). It `uses` the `import` of each resource type with a driver, the change operations of each writable one, and `approval`; it is the only workflow that may call a change operation. Its input is `{ only?, bind?, answers? }` (any other field refused): `only` the declared ids (`<file>#<export>`) or orphaned lockfile keys to plan, else all; `bind`, a declared id to the vendor's id of the object to bind it to; `answers`, by id or key, `recreate` or `forget` for a gone object, `forget` or `delete` for an orphaned binding.

```ts
const runId = await client.apply(
  { answers: { "resources/infra.ts#store": "recreate" } },
  { startedBy: { id: "alice" } },
);
const report = await client.applyReport(runId); // { plan: { problems, rebinds, steps }, results, lockfile: { written, revision?, bindings } }
```

The run reads the data files and the lockfile in its first step (`apply:data-files`; a secret's marker stays in `desired`, a plain write-only value does not), with the lockfile's `rebinds`: what changed in it since apply last wrote it (`diffLockfiles` against the bindings the latest live apply run's last `apply:lockfile` step wrote), changes someone else made. It imports each declared resource as drift does (by the binding `bind` gives, else the lockfile's, else its identity), then plans each one `only` wants, each after the resources it names, as a `PlanStep` (`{ id, vendor, type, action, … }`): `bind` (to the object `bind` gives, or the one its identity `found`, by its binding id), `create` (unbound and nothing found: `planned` and `unknown` from its type's `plan`), `update` or `replace` (its bound object as `plan` says, with drift's `fields` and the paths that force a replace), `none`, `gone` (its bound object is no longer there: skipped unless answered, since a recreated database looks fine and has lost its data; a type with `stateless: true`, holding no data, is planned as a `create` instead, unless answered), and `orphan` for each binding no declaration has (skipped unless answered: deleting a declaration never deletes its object). What cannot be planned (a read-only type that is absent or drifted, an answer that cannot be done, an id the input names that nothing declares) is one of the plan's `problems`, with no step.

When the policy would hold any change call the plan makes (asked ahead, in the step `apply:policy`, as each call would ask it), the run asks one approval of the first approver it names, titled "Apply resource changes", covering every change operation in the plan, with the plan as JSON in its `details`; a policy that lets a covered call through once approved (`approvedFor`) then holds none of them again. Then each step runs, in order: `create`, `update` (with `expect`, the plan's action and replace, so a vendor that now plans otherwise refuses with `plan_changed`), `delete`, or only the lockfile changed. A reference to a resource the vendor holds by another field (`by`) is given that resource's binding id, one made earlier in the run included. Right after any step that changes a binding, that binding is changed on the lockfile as it is then (so another run's change made meanwhile stays), written whole and committed through the worker's `source` (`apply:lockfile`: `Apply: create resources/infra.ts#store (supabase.project abcd…)`, by the person who started the run), so an object made is never left unbound. Each step's result is `done`, `skipped` (unanswered) or `failed` (with `error`; the run goes on). A sandbox run writes nothing: the report's `lockfile.bindings` is its copy. `ApplyPlan`, `PlanStep`, `ApplyReport` and `ApplyResult` are the types, also in `@sanoma-ai/workflows/describe` and `/shared`.

This package knows nothing of OpenTofu. Resource types from an OpenTofu provider are generated by [`@sanoma-ai/bridge/tfschema`](../bridge/src/tfschema/AGENTS.md), which turns the provider's schema document into zod schemas and flagged fields (`resources.gen.ts`); `@sanoma-ai/bridge` depends on this package, never the other way round.

### Hosts

A host is a resource type that runs the company (a container, a Render service, a Fly app): `defineResource({ …, writable: true, host })`, where `host` (`HostSpec`) says where the type takes the runtime's inputs, by dotted path into its fields (`inputs: { source, ref, secrets, port }`, `secrets` a write-only field), which field apply fills with the commit (`revision`, which a data file may not declare: it names a branch, never a commit), what it can do (`capabilities: { lifetime, publicUrl, buildsFromGit, staticEgress }`), and how its state reads (`outputs(state) → { url, revision?, healthy }`). `defineResource` refuses a `host` that names no field, or whose `secrets` is not write-only. A write-only field may be a map of secrets (`secrets: { SANOMA_DATABASE_URL: secret("DATABASE_URL") }`): its markers are kept as one at the field is. A host type is `stateless` (a `ResourceSpec` field, default true for a host): its objects keep no data, so replacing or recreating one is routine. `source` is a clone URL, or a reference to a declared repository with a `by` field holding one.

A config whose connectors declare a host type has the built-in operation `sanoma.source.resolve` (`SOURCE_RESOLVE`, effect `read`): `{ url, ref } → { revision }`, by `git ls-remote` on this machine (a branch, then a tag, peeled; a full commit id is itself). Apply calls it for each host it plans, and gives the host the commit as its `revision` and the clone URL as its `source` (a referenced repository's, from its `by` field); a host whose ref does not resolve is a problem of the plan. The drift run calls it for every host it reads. `resolveRevision(url, ref)` is the same, outside a run.

### Secrets

Never put a secret in a workflow's input or an operation's input or output. They are persisted verbatim: DBOS keeps every step's input and output in Postgres, the ledger records each call's input and output, an approval a policy asks for carries the held call's input, and the app shows all of it to anyone who can reach it. A driver reads its credentials when it is called (from the environment or a secret store), and an operation that creates a secret (an API key, a password reset link) returns a reference to where it is stored, not the secret.

A secret a resource needs is named, never written. A data file gives `secret("NAME")` (from `sanoma/resources`; `NAME` upper case, as a variable's, and never `SANOMA_…`, sanoma's own) at a write-only field, and `secret("NAME", { generate: true })` for one apply makes when none is stored: `database_password: secret("SUPABASE_DB_PASSWORD", { generate: true })`. Declarations, checkpoints and the ledger hold its marker, `{ "$secret": "NAME", "generate": true }`; the resource type refuses one at any other field, and its schema does not judge it. The driver resolves the markers just before the vendor call, `await resolveSecrets(input, call.secrets)`: each is replaced by the stored value, a `generate` one with none stored first made (32 random bytes, base64url) and stored, and one with nothing stored fails the call for good. `call.secrets` is `{ get(name), ensure(name, make) }`: the environment wins, else the `sanoma_credentials` table (see [Credentials](#credentials)); a fake's and a sandbox run's are in memory (`memorySecrets()`, which a driver's tests use too).

### Versions

Every run is stamped with the application version of the worker that runs it, `<appName>@<version>`, and only a worker on that version recovers it after a restart. Versioning is automatic: the version is a hash of each workflow's name, the source of its `run` function, its operations and its input schema, which is DBOS's own scheme applied to the workflow code rather than to the runtime's registration wrapper (DBOS would otherwise see one identical function for every workflow and never change). The hash cannot see functions `run` calls that live elsewhere, op schemas, drivers or the policy: edit those with no run in flight, or restart on the old code first. To name a version instead (a git commit, say), set DBOS's `DBOS__APPVERSION` environment variable; it is prefixed with the app name the same way. A new version becomes the app's latest when it first starts, and runs queued without a version go to the latest; a worker started on an older version (a rollback) warns instead, unless started with `{ promote: true }`. The hash is of the code as it runs, so TypeScript source and the compiled JavaScript of the same workflow have different versions.

When a worker starts, it warns about unfinished runs it will not pick up, naming them: runs started on another version, and runs queued on another queue. Run the version that started them, or fork each onto the current version with `DBOSClient.forkWorkflow(id, step, { applicationVersion, queueName })` and cancel the original.

Queues used to be one `sanoma` queue for every app and are now `sanoma:<appName>`, so runs queued before the change are never started. Sandbox runs had their own queue, `sanoma:<appName>:sandbox`, until they went on the app's; the warning names the runs left on it, and a sandbox run forked or resumed past its seed step fails at once, so start its scenario again or cancel it. On a local database, `pnpm db:down && pnpm db:up` resets it.

## Keeping workflows replay-safe

A run is replayed after a restart by calling the function again and reading each step's result back, so workflows and policies must do the same thing every time, and must reach vendors only through `ctx` so the policy sees every call. Two checks guard against getting that wrong by accident, on files under `workflows/` and `policies/`. They are not a sandbox: they read the source, and code written to get around them can.

oxlint, with the rules this package ships in `oxlint.json`, refuses the clock (`Date`, `performance`), randomness (`Math.random`, `crypto`), the network (`fetch`, `WebSocket`), timers, `process`, `globalThis`, `Promise.all` and its kin (use `ctx.all`; nothing races), and imports of `@sanoma-ai/testing`, `@sanoma-ai/app`, `@sanoma-ai/workflows/describe`, `@sanoma-ai/workflows/fake`, `@sanoma-ai/workflows/plugin`, `@sanoma-ai/workflows/scenario`, `@sanoma-ai/workflows/scenarios`, `@sanoma-ai/connector-*/fake` and `@sanoma-ai/connector-*/driver`. From `@sanoma-ai/workflows` it allows only `defineWorkflow`, `definePolicy`, `allow`, `deny`, `approve`, `approvedFor`, `allowAll`, `mayDecide`, `errorCode`, `z` (which `sanoma` re-exports) and types (the list is `allowImportNames` in `oxlint.json`; the `sanoma` package's own `oxlint.json` allows the same names from `sanoma` and refuses its subpaths): the rest could start runs or approve the run's own approvals (`SanomaClient`, `startWorker`), forge the audit record (`jsonlLedger`, `memoryLedger`: a store keeps the first record per id) or read credentials. Each message names the `ctx` replacement. `sanoma check` runs it, through `sanoma/oxlint.json`, which carries these rules; without `sanoma`, extend this package's from your `.oxlintrc.json` by its path: oxlint resolves `extends` as a file, not a package name, so `@sanoma-ai/workflows/oxlint` would not load. The `workflows/**` and `policies/**` globs resolve against your config:

```json
{
  "extends": ["./node_modules/@sanoma-ai/workflows/oxlint.json"]
}
```

`describeConfig` (`@sanoma-ai/workflows/describe`) reads each workflow's file once, the one way the worker does, and lists on the workflow's entry, in `problems`, what oxlint can't express: imports come only from `@sanoma-ai/workflows` or `sanoma`, a `@sanoma-ai/connector-<vendor>` package, zod, or a relative file that stays inside the file's `workflows/` or `policies/` directory (so not `../sanoma.config.ts`, which holds the config); no namespace import of either package; no dynamic `import()`; and no `instanceof` against `DriverError`, `SanomaError`, `PolicyDeniedError` or `RejectedError`. On a replay DBOS rethrows a serialized copy of an error, which is no instance of its class, so a branch on `instanceof` would go another way than the first time and the run's steps would fall out of step. Read `errorCode(err)` instead.

In each workflow's `run` it also lists what the run's graph could not show, the same problems that make the outline `{ error }` and `startWorker` refuse (see [Outline](#outline)): `ctx` used other than called directly or read for `ctx.runId` (passed to a helper, aliased, destructured, or `run` taking it destructured); a call on `ctx` that is no operation or built-in (`ctx.ghost.post()`); `ctx.all` over members made elsewhere (write the list, or `items.map(…)`, in the call); a `ctx` call inside a function the outline does not read (one defined inside `run`, or a callback not passed to `ctx.all`, `.map`, `.forEach` or `.reduce`) or in a `finally`; and, in `run`, in a `finally` and in the callbacks that make `ctx` calls, a `return` before the end, a `throw` outside a `catch`, a `break` out of a loop or to a label, and `continue`; and a [step name](#step-names) that is not a literal or reads as an operation's id or `Sleep`, and two steps given one name. A function without `ctx` calls computes, and may do as it likes. Each message says what to write instead: inline the helper, use `if`/`else` around the rest, name the call. Each problem has its `line` and `column` in the entry's `file` (an unreadable file, or one that holds no workflow of the entry's name, is the outline's error at 1:1); `sanoma check` prints them, as `problemLine` does, and the app's startup warns of them. A test holds a repo to the same:

```ts
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { expect, it } from "vitest";
import config from "../sanoma.config.ts";

it("has no problems", () => {
  const { problems, workflows } = describeConfig(config);
  expect([...problems, ...workflows.flatMap((wf) => wf.problems)]).toEqual([]);
});
```

## Fakes for tests

`@sanoma-ai/workflows/fake` exports `defineFake(connector, { initial, ops }, { calls? })`, the fake a connector package attaches the maker of (`withSetup`), which builds an in-memory vendor for a connector: `ops` implements every operation against the fake's state, typed by the connector as `defineDriver` is, and the fake adds what a real vendor does around them (a repeated idempotency key gets the first reply and changes nothing) and faults a test can inject (`failNext`, `loseReply`, `rateLimit`, `hold`). `update(change)` changes the state as someone at the vendor would, so the next call sees it. `calls` logs into a list given, so several fakes share one ordered log. The connectors' own fakes (`@sanoma-ai/connector-ghost/fake` and the others) are built with it. The entry also declares `ResourceFake`, the contract of a fake that holds its vendor's objects by resource type and import id (`put`, `override`, `remove`, with fields in the resource's shape), which `@sanoma-ai/bridge`'s `tfFake` meets and a scenario's [resource steps](#scenarios-and-sandbox-runs) seed through. It is a separate entry so the runtime carries no test tooling, and the lint refuses it in workflow files.

## Scenarios and sandbox runs

A scenario is a Gherkin feature file that says what a sandbox run starts from, how its approvals are decided and what it should do. A sandbox run is a real run of a workflow, under the same policy and approvals, that calls fake vendors instead of the drivers, so a workflow can be tried before it touches anything. The fakes are the ones the connectors carry, and the scenarios are the `.feature` files in `scenarios/` in the config's root: nothing to add to the config.

[Cucumber](https://github.com/cucumber/cucumber-js) (`@cucumber/cucumber`, pinned) runs the feature files, in this process, in two ways, and never drives a run itself. Compiling a file, its steps only record what they say (the seeds, the faults, the workflow and its input, the decisions, what each `Then` is about), which gives the scenarios the worker seeds from, `drive` decides by and the app lists. Checking a run, the scenario's `Then` steps run against the run's ledger as assertions, and the rest do nothing. Steps come from three places: the generic steps below, the steps each connector ships (`withSetup`'s `steps`, see [Steps a connector ships](#steps-a-connector-ships)), and the company's own (the config's `steps`), so one scenario can combine steps from several connectors. Sanoma registers them all with Cucumber from the config; a connector never imports Cucumber.

The fakes are made per run: a connector attaches the maker of its fake (one per vendor; `resolveConfig` refuses two different ones for one), and each sandbox run calls it once for a fake of its own, so it starts from the fake's initial state plus its scenario's `Given` seeds. A root without `scenarios/` has no scenarios. Every `.feature` file under it is read; each must hold at least one scenario, and each scenario's name must be unique across them. Each row of a `Scenario Outline`'s examples is a scenario of its own, named from the outline's title; rows whose names come out the same get their line appended, such as `Launch (line 12)`.

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

The steps, as [Cucumber expressions](https://github.com/cucumber/cucumber-expressions) (`{op}` is an operation id, `{workflow}` a workflow name, `{who}` a person's id or a group's name, `{string}` a quoted string, `{resource}` a resource type such as `github.repository`, `{declared}` a declared resource as a drift report names it, `resources/identity/github.ts#website`, and `{field}` a field's dotted path; `And` and `But` take the keyword before them):

| Keyword | Step                                                                                     | What it does                                                                                                                               |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Given   | `{op} was called with` and a JSON doc string or a two-column table (`name \| value`)     | Seeds the fake: calls the operation through it before the run                                                                              |
| Given   | `{op} fails once`, `{op} is rate limited once`, `{op} loses its reply once`              | Injects the fault into the operation's next call (`failNext`, `rateLimit`, `loseReply`); its step has `fault: true`                        |
| Given   | `{resource} {string} has` and a two-column table (`field \| value`) or a JSON doc string | The vendor's fake holds the object with these fields: `Given github.repository "website" has` then `\| has_wiki \| true \|`                |
| Given   | `{resource} {string} is gone`                                                            | The vendor's fake no longer holds the object: `Given github.repository "docs" is gone`                                                     |
| When    | `{workflow} runs with` and a JSON doc string or a two-column table (`name \| value`)     | The workflow the scenario runs, and its input                                                                                              |
| When    | `{workflow} runs`                                                                        | The same, with the input made up                                                                                                           |
| Any     | `{string} is approved by {who}`, `… with note {string}`, and the `rejected` forms        | How the approval with that title (or id, such as `approval-2`) is decided                                                                  |
| Then    | `{op} was called with` and a JSON doc string or a two-column table                       | Expects a call whose input has at least these fields                                                                                       |
| Then    | `{op} was called`, `{op} was not called`                                                 | Expects a call to the operation, or none                                                                                                   |
| Then    | `step {string} was called with` and a JSON doc string or a two-column table              | Expects a call by the [step](#step-names) of that name whose input has at least these fields: `Then step "Draft the post" was called with` |
| Then    | `step {string} was called`, `step {string} was not called`                               | Expects the named step to have run, or not                                                                                                 |
| Then    | `step {string} ran {int} time(s)`                                                        | Expects the named step to have run that often: `Then step "Draft the post" ran 2 times`                                                    |
| Then    | `{op} was denied`                                                                        | Expects the policy to have denied a call to it: `Then github.repository.import was denied`                                                 |
| Then    | `{op} was held for {who}`                                                                | Expects an approval for that approver to have held it: `Then stripe.product.import was held for finance`                                   |
| Then    | `{declared} is drifted in {field}`                                                       | For a drift run: `Then resources/identity/github.ts#website is drifted in has_wiki`                                                        |
| Then    | `{declared} is clean`, `{declared} is gone`, `{declared} is absent`                      | For a drift run: `Then resources/identity/github.ts#docs is clean`                                                                         |
| Then    | `apply creates {declared}`                                                               | For an apply run: it created the resource (or made a gone one again): `Then apply creates resources/identity/github.ts#docs`               |
| Then    | `{declared} is bound to {string}`                                                        | For an apply run: the lockfile it ended with binds it so: `Then resources/identity/rules.ts#docsMain is bound to "BPR_docs:main"`          |
| Then    | `the run succeeds`, `the run fails`, `the run fails with {string}`                       | Expects the run to finish, or to fail (with that error code, such as `"approval_rejected"`)                                                |

A resource step names an object a vendor's fake holds, by resource type and import id (a binding id, or an identity: a GitHub repository's name, a branch protection rule's `repository:pattern`; a fake also finds an object by its binding id, such as a repository's `node_id`), for a fake that holds objects (`@sanoma-ai/bridge`'s `tfFake`, as the GitHub and Stripe fakes are; a sandbox run whose scenario seeds a resource of another vendor's fake fails with `invalid_input`). `has` puts the fields on the object (`put`: over the one the vendor has, keeping its other fields, or a new one), each read as a table cell is for an operation's input and checked against the type's schema; `is gone` removes it (`remove`), and is nothing when there is none. The run's own fake is what is seeded. A fake starts a sandbox run with what its replies were recorded with, so a declared resource the recording lacks is `gone` to a drift run until a scenario puts it.

The policy steps read the run's ledger: `was denied` holds when the policy's decision on some call to the operation is `deny`, and `was held for {who}` when an approval addressed to that person (by id) or group (by name) holds it, whether the policy asked for it on that call or the workflow asked for one that `covers` it. A failed step says what happened instead: `github.repository.import was allowed, not denied`, `stripe.product.import was held for finance, not marketing-lead`. The drift steps read the report a finished [drift](#drift) run returned, so their scenario must run `drift` (a parse error otherwise), as the apply steps read an apply run's report, and an apply run's input is only what `runs with` gives, never made up; a failed one says how the report found the resource: `resources/identity/github.ts#website is drifted in has_wiki, not clean`, `… is gone, not drifted in has_wiki`, or that the report has no such resource.

The `step` steps name a [step](#step-names) of the scenario's workflow, after its `When`: one whose name is no step's, or several's (a default an operation called twice shares), is an error listing the names it has, so a test names one call (an unnamed call with a computed segment, `ctx.ghost.post[action](…)`, is named in a run by the operation it calls, so it shares that operation's id; an approval whose title is no literal is named by its title in a run, which the outline cannot tell apart), and `was called with` checks its operation's input fields. They read the ledger by the `name` its records carry: a step ran when a call by it was made (not denied, rejected or failed for good), a sleep by it started, or the workflow asked for an approval of that title; a policy's hold on a call is that call's, not a run of its own. A call in a loop runs once per pass: `ran 3 times` for three items. A failed one says what happened: `step "Draft the post" ran twice, not 3 times`.

Cucumber matches a step by its text alone, whatever its keyword; Sanoma then picks the step of that keyword, so `{op} was called with` seeds after `Given` and expects after `Then`. Two different expressions matching one step's text is ambiguous whatever their keywords.

Each scenario has exactly one `When … runs`. An operation can add its own steps with `phrases` in its spec: `{ given: "a post titled {title} exists", expect: "a post titled {title} is created" }`. Each `{name}` is a field of the operation's input (a phrase naming another is a configuration error); it matches what `{string}` does (a quoted string) or one word, and is read as a table cell is. A field may have any name, even one a parameter type has (`op`, `string`, `int`): the phrase reads it as the field. A `given` phrase seeds the fake as `was called with` does, and an `expect` phrase (for `Then` steps) expects a call with those fields. `describeConfig` lists them as an operation's `phrases`.

A doc string is a JSON object. A table cell, and a phrase's field, is read as text when its field takes text, else as JSON (a number, `true`, a list): `| title | 123 |` is the text `"123"` for a string field, and `| count | 5 |` the number 5 for a number field. Every field a doc string or a table names must be one the input has (the error lists those it has), and its value one the field takes; a value it takes neither as text nor as JSON, such as `yes` for a boolean, is an error. A `Then` checks each field it names this way, not the whole input.

Input the scenario leaves out is made up from the schema with [zod-schema-faker](https://github.com/soc221b/zod-schema-faker), seeded from the scenario's name, so one scenario always makes up the same values; it is then parsed by the schema. A step no rule matches, or more than one, an unknown operation, workflow or field, a value its field does not take, a missing or second `When`, a doc string that is not JSON, and a file Gherkin cannot parse are errors naming the file and line; the first lists every step there is, each operation's phrases under its id and each connector's steps under its vendor. A file with an error has none of its scenarios; the other files still load.

Checking a run, every `Then` step runs and judges the run on its own: one that does not hold says why, and the steps after it are still checked.

### Steps a connector ships

A connector's package declares steps with `defineSteps(vendor, ({ given, then }) => …)` (from the main entry) and attaches them with `withSetup(ops, { driver, fake, steps })`; a company passes its own as the config's `steps`. A step is a Cucumber expression (with the built-in parameter types, `{string}`, `{int}`, `{word}` and the rest) and a pure function of its parameters' values: compiling calls it, the app too, whenever a feature file changes.

```ts
import { defineSteps } from "@sanoma-ai/workflows";

export const blueskySteps = defineSteps("bluesky", ({ given, then }) => {
  given("Bluesky fails to post once", () => ({ op: blueskyOps.post.create, fault: "failNext" }));
  then("Bluesky has a post with {string}", (text: string) => ({
    op: blueskyOps.post.create, // what the step is about, for the graph
    called: true,
    check: (run) =>
      run.calls(blueskyOps.post.create).some((c) => c.input.text.includes(text))
        ? undefined
        : `no Bluesky post has "${text}"`,
  }));
});
```

A `given` returns a `Seed`: `{ op, input, as? }` calls the operation through the run's fake before it starts, `{ op, fault }` injects `failNext`, `rateLimit` or `loseReply` into its next call. A `then` returns an `Expect`: `op` and `called` say what it is about (the graph marks the operation), and `check(run)` reads the run (`RunView`: its `records`; `calls(op)`, the calls made without an error; `seeded(op)`, what the `Given` steps seeded through it; and `made(op)`, both: each `{ input, output }`, typed by the operation) and returns why it does not hold, or throws; returning nothing passes. In `scenario.expect` such a step is `{ step, custom: true, op?, called? }`.

The same steps test the connector's own operations, in its `features/`: there the generic steps below call an operation directly (no worker, no policy) on a fake or on the driver over recorded replies, and `$name.field` in a table cell is a field of what a `Given` named `as` returned (`| id | $draft.id |`). [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features) runs them.

| Keyword | Step                                                              | What it does                                                                                     |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When    | `{op} is called with` and a JSON doc string or a two-column table | Calls the operation with that input, the rest made up; the call and its output or error are kept |
| Then    | `it returns` and a two-column table of fields of its output       | Expects the last call to have returned at least these fields                                     |
| Then    | `it fails with status {int}`                                      | Expects the last call to have failed with that vendor status                                     |

A workflow's scenario refuses `{op} is called with`, and an operation's own test refuses a step that runs a workflow, decides an approval or seeds a resource; a fault needs the fake.

`@sanoma-ai/workflows/scenario` (server-side only; the lint refuses it in workflow files) compiles and checks them:

- `loadScenarios(resolveConfig(config))` resolves to `{ scenarios, errors }`: every scenario, compiled by Cucumber, and an error for each file that does not compile or name used twice. It reads the resolved config's `ops`, `workflows`, `types`, `steps` and `scenarios` (the directory). A scenario's `line` is its keyword's, or its examples row's. A scenario's `text` is its own lines of its file, for display: from its keyword line to the end of its last step (doc strings, tables and an outline's examples included), less that line's indent; its `steps` are each `{ text, kind, op?, name?, called?, decision?, fault? }`, in order: `op` names the operation a step is about, `name` the step a `step "…"` Then is about, `called` says whether a `Then` about either expects a call (or a run) or none (`ran 0 times` too), `decision` that it expects the policy to have denied it (`denied`) or held it (`held`), and `fault` marks a `Given` that injects a fault rather than seeding. It compiles the files again only when one has been added, removed or written since its last call with that config (a file's name, `mtimeMs` or size changed); until then it resolves to the same object, so the worker and the app can call it on every run and every request. Compiling builds Cucumber's support library from the config (once per resolved config) and runs the files: a few milliseconds.
- `check(scope, scenario, records)` runs the scenario's `Then` steps, as its feature file reads now, against a run's ledger records, and resolves to `{ step, ok, detail? }` for each expectation, in order; it rejects when the file no longer has the scenario as it was compiled (load the scenarios again first). Each `Then` is judged on its own, so one that does not hold leaves the rest checked. For the generic steps: a call matches when its parsed input contains the expected input (every field, at every depth); a call is an `op.called` record without an `error`, so one the policy denied, an approver rejected or the vendor failed for good was attempted, not made (`was not called` passes, and a failed `was called` lists the attempts in its `detail`); a denial is read from the `op.called` records' `decision`, a hold from `approval.requested` (its `op`, or its `covers`); a named step's runs from the `name` on the `op.called` (made), `sleep.started` and workflow-asked `approval.requested` records; an outcome is read from `run.finished` or `run.failed` (`ok: false`, "run not ended", before either); and a drift result from the `DriftReport` a `run.finished` holds as its `output`. A connector's or the company's `Then` whose `check` throws fails with the error's message.
- `testFeature(scope, file, line, { driver, fake? })` runs one scenario of a connector's own feature file as an operation's test, rejecting with its first step that did not pass at its `file:line`, and `featureScenarios(scope, dir)` lists a directory's scenarios from a dry run: what `describeFeatures` is built on.
- `drive(client, runId, scenario, { timeoutMs? })` decides the run's approvals as the scenario says until the run ends, and returns its `RunSummary`. Each pending approval takes the decision naming its title or id, else the next decision left that names no approval of the run: none it has asked for, and none in `scenario.approvals`, the titles its workflow's code asks for where they are string literals (read from its [outline](#outline)). So `"the first one"` is decided in order, but a decision for `"Final check"` is never spent on the approval before it. An approval with no such decision throws, naming the decisions left. Each decision waits for the run to read it until the timeout; a worker that has not read it by then throws `run_running`, as does a run still going. `by` is a person's id, so a scenario cannot decide an approval addressed to a group.

Start a sandbox run with `client.start(workflow, input, { startedBy, sandbox: "<scenario name>" })`. `sandbox` must be a non-empty string, else `start` throws `invalid_input`; the worker looks the scenario up. The input is the caller's (a scenario's own is `scenario.input`). The worker then:

- parses the input, then seeds its own fakes from the scenario, once, in a step named `sandbox:seed`: it reads the scenario, makes a fake of every vendor for the run (each maker, called once), checks the scenario against them, calls each `Given` operation through its fake, puts or removes each `Given` resource in its fake, and injects the faults into them. It records `scenario.seeded` (the scenario, and each seed: an operation's with its input and output, a resource's with its type's id, its import id and its fields, or `gone: true`) right after `run.started`. A scenario that does not exist or runs another workflow, a workflow using (or a scenario seeding) an operation with no fake, a scenario seeding a resource of a vendor whose fake holds none, and a resource seed the fake refuses (a field its provider's shape lacks), fail the run with `invalid_input`, the last naming the step.
- calls its own fakes, never a driver, under the same policy and approvals as a live run.
- does not wait on `ctx.sleep`: it still records `sleep.started` with the real `until`, and goes straight on.
- runs it on the app's queue, as any run: sandbox runs share no fakes, so several run at once, and one waiting on an approval holds up no other.
- prints nothing of it through DBOS's log: none of DBOS's warnings from inside it (a step's failed try among them: a fake's `fails once` is on purpose), nor the error the run fails with. Its ledger and its status say what happened; a live run's tries and failures print as ever.

A sandbox run does not survive a worker restart: its fakes keep their state in the worker's memory, so a run whose seeding DBOS replays from its checkpoint (after a restart, or in a fork) fails with `invalid_input`, "Sandbox run … was interrupted by a worker restart and the fakes' state is gone; start the scenario again", rather than going on against fakes in some other state.

`RunSummary.sandbox` names the scenario a sandbox run was seeded from (kept in DBOS's `attributes` for the run). Reusing a run id with another `sandbox`, or none, is `invalid_input`, as with another input.

`runScenarios(config, { databaseUrl, startedBy?, timeoutMs?, log? })` from `@sanoma-ai/workflows/scenarios` (server-side only, like `/scenario`) runs every scenario of the config as a sandbox run, on a worker it starts on `databaseUrl` with an in-memory ledger and stops after, and returns `{ passed, failed }`: the names of the scenarios whose every check held, and one `{ scenario, step, message }` per step that did not (with `check`'s detail), per run that could not be driven to its end (at its `When` step), and per feature file that did not load (`step: "did not load"`); a config whose root has no `scenarios/` passes and fails nothing. `sanoma check` runs it. `runScenario(scenario, { client, scope, startedBy?, timeoutMs? })` runs one against a worker you started, `scope` being what it was loaded from (the resolved config). To run them as tests, a vitest test each, use `describeScenarios` from [`@sanoma-ai/testing/scenarios`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#scenarios), which wraps the same `runScenario`.

## Building your own UI

`@sanoma-ai/app` is one UI over a config; another (a Slack bot, an internal tool) can be built on the same pieces, which the package exports for that:

- `describeConfig(config)` and its types (`ConfigDescription`, `WorkflowEntry`, `OpEntry`, `VendorEntry`, `ResourceTypeEntry`, `DeclaredResource`, `ResourceProblem`), and `readDataFiles(root, connectors)` and `readResources(config)`, from `@sanoma-ai/workflows/describe`: what to render, as plain JSON, with each workflow's outline. It is a separate entry so the worker never loads the parser the outline uses, and the lint refuses it in workflow files. `resolveConfig(config)` returns the checked config as a `ResolvedConfig`, with the operations and drivers by id, the resource types by `<vendor>.<type>` (`types`), the workflows by name (the built-ins `drift` and `apply` among them), its `root` and each vendor's `credentials` (`CredentialStatus`); `isOp(x)` tells an operation from a built-in in a workflow's `uses`.
- `SanomaClient`: start runs, list them (`runs({ limit, status, workflow })`), read a run's ledger and approvals, decide approvals, with the checks described above, and start a drift check or an apply and read its report (`drift`, `driftReport`, `apply`, `applyReport`, see [Drift](#drift) and [Apply](#apply)).
- `APPROVALS_EVENT` and `decisionEventOf(approvalId)`: the DBOS events a run publishes its approvals and each decision on, for a UI that reads DBOS directly. `ApprovalMessage` is the zod schema of a decision as a run reads it. `RunArgs` is what a run receives: its input, `startedBy` and, for a sandbox run, its scenario as `sandbox`.
- `mayDecide(approval, principal)` and `approverLabel(approver)`: who may decide, and how to name them, the same way the run does. `isEnded(status)` and `ENDED_STATUSES`: the run statuses that read no more decisions; `RUN_STATUSES`: every run status, in the order a run may pass through them.
- Errors: `errorCode(err)` for the code to branch on, `errorMessage(err)` for the text of anything thrown, `invalidInput(what, issues)` to build an `invalid_input` error from zod issues (`InputIssue` is one issue, without symbols in its path), and the classes `SanomaError`, `PolicyDeniedError`, `RejectedError` and `DriverError`. Read codes with `errorCode`, never `instanceof`.
- `@sanoma-ai/workflows/shared` exports `mayDecide`, `approverLabel`, `errorMessage`, `isEnded`, `ENDED_STATUSES`, `RUN_STATUSES`, `DRIFT_WORKFLOW`, `isLoopback` (whether a host is this machine: `localhost`, `127.x.x.x`, `::1`), `problemAt` (a data-file problem's `file:line:column`), `problemLine` (a problem as one line: `file:line:column: message`, `file: message` or the message), `credentialReady` (a variable is set, or optional and unset) and the `RunStatus` and `CredentialStatus` types, the resource types' types (`Resource`, `ResourceSpec`, `ResourceFields`, `References`, `FieldReference`, `Declared`, `Declaring`, `DeclaredResource`, `ResourceProblem`) and the drift report's (`DriftReport`, `DriftResult`, `DriftField`, `DriftStatus`), with nothing else: no DBOS or Node imports, so a browser bundle can use them. The main entry exports them too.
- `LedgerRecord` and `LedgerStore` for the audit record (`LedgerBody` is a record without the fields every record carries, and `LedgerGroup` a record's `ctx.all` tag), `postgresLedger(databaseUrl)` (the default), `jsonlLedger(dir)` and `memoryLedger()` to keep it, and `RUNTIME_VERSION`, this package's version as the runtime reports it.

### Outline

`outlineWorkflow(wf)`, from `@sanoma-ai/workflows/describe`, reads a workflow's shape from the file that defined it, for drawing it before it runs, and the worker holds every run to it, so the drawing is what a run can do and nothing else. `describeConfig` returns it as each workflow's `outline`:

```ts
import { outlineWorkflow } from "@sanoma-ai/workflows/describe";

outlineWorkflow(announce);
// { nodes: [{ kind: "op", path: "0", id: "ghost.post.create", span: [913, 974] }, …, { kind: "approval", path: "2", title: "Review launch copy", span: […] }, …], file: "/…/workflows/announce.ts" }
```

It parses the file with oxc-parser (TypeScript in a repo, `.tsx` included, JavaScript once built) and lists, in the order they run, the calls `run` makes on its first parameter, whatever it is named: operations (`op`, with a `*` for a computed segment such as `ctx[vendor].comments.list`, as the built-in `drift` imports each resource by its type, with the step's `name`), approvals (with the title, when it is a string literal or a top-level `const` holding one), sleeps (with their `name`), and `ctx.all`: `all` with one branch per member of an array literal, or for anything else, such as `ids.map(…)`, `each` with the callback's calls as its `body`. Around them it shows loops and `.map`, `.forEach` and `.reduce` callbacks as `repeat`, `if`, `switch`, `?:`, `&&`, `||` and `??` as `branch` (one case per arm that makes calls, plus one empty case for the way past them when there is one: an arm without calls, an `if` without `else`, a `switch` without `default`, the right side of `&&` not run), and `try` / `catch` as `try`, with the handler's calls as `handler`; a `finally` is not read. It does not read the functions `run` calls, whether defined outside `run` (a helper that takes `ctx`) or inside it, only callbacks passed to `ctx.all`, `.map`, `.forEach` and `.reduce`, and it cannot see how many times a loop runs or which arm is taken: the ledger says that, per run. Each loop, and each `each`, has a `label` read from its code: `for each of subscribers` for `for (const s of subscribers)` or `subscribers.map(…)`, `for each key of` for `for…in`, `repeat while queue.length` for a `while`, `do` or `for` with a test, and `repeat` for one without (the code on one line, cut at 40 characters). A loop's label is no step's name, and need not be unique.

Each node's `path` is its place in the outline: its index among its siblings, under its parent's path and the index of the branch, case or body it is in (`"2"`, `"2.1.0"`), the same for the same tree however the code is laid out. Each node's `span` is where its code is in the file, as UTF-16 offsets (a string index, and what CodeMirror counts): the call, the `ctx.all(…)`, the loop or `.map(…)` call, the whole `if` / `else` chain, `switch`, `?:` or `&&`, or the `try` statement. `describeConfig` puts the file's text beside the outline, as the workflow's `source`, with `\n` line endings; a server can keep that from its clients, since it is a whole file.

`defineWorkflow` records the file it is called from as the workflow's `file`, by itself; nothing passes it, and a definition made from code with no file (an eval, a bundle without one) is refused. The outline is read from that file, which must hold the workflow as an object literal with its `name` (a string literal, or a top-level `const` of the file holding one) and a `run` function taking `ctx` by name; otherwise it is `{ error }`, saying why (the file could not be read or parsed, holds no workflow of that name, or `run` destructures `ctx`). It is `{ error }` too, one line per problem at `file:line:column`, when `run` holds what the graph cannot draw: the control flow and uses of `ctx` that `lintWorkflow` refuses (see [Keeping workflows replay-safe](#keeping-workflows-replay-safe)). Either way `startWorker` refuses the config, since nothing could say where the workflow's calls are.

The worker reads each workflow's outline when it starts and holds every run to it. Each `ctx` call captures where the workflow made it, from the stack, and the worker finds the call node whose code holds that position; a call from anywhere else fails the run with `call_not_in_outline`, naming the file, line and column and what to do (inline the helper): from a function the outline does not read, from another file, from a `finally`, or through an alias (`const create = ctx.ghost.post.create`). `ctx.now()` and `ctx.runId` are exempt: a read of the clock, and a value. The records a call writes name its node as `node` (its `path`): `op.called`, `sleep.started`, `approval.requested` (a policy hold's approval names the held call's node) and each `group` of a `ctx.all`, so a UI places a run's steps in the code exactly, a loop's every pass on its one node. Records written by a worker from before calls were placed have no `node`.

Status: early (0.x). The API may change between minor versions.

TODO: redact fields a schema marks `.meta({ sensitive: true })` from the ledger, the approvals event and DBOS's step records, so a secret passed by mistake is not kept.

License: FSL-1.1-ALv2.
