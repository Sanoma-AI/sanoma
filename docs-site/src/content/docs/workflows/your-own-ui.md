---
title: Building your own UI
description: "Build an interface over a company config, display workflow outlines, and inspect runs and approvals."
sidebar:
  order: 13
---

A Slack bot or internal tool can use the same company config as `sanoma/app`. Use `describeConfig` to discover the workflows and operations you can display. Use `SanomaClient` to start a run, read its ledger, or submit a decision.

## Interface APIs

- `describeConfig(config)` and its types (`ConfigDescription`, `WorkflowEntry`, `OpEntry`, `VendorEntry`, `ResourceTypeEntry`, `DeclaredResource`, `ResourceProblem`), and `loadDataFiles(root, connectors)` and `readResources(config)`, from `sanoma/workflows/describe`: what to render, as plain JSON, with each workflow's outline. Its shape is `ConfigDescriptionSchema`, from `sanoma/workflows/description` (zod and nothing of Node, so a browser may import it): each entry type is inferred from its schema, and the schema refuses a key it does not name.

  Beside what the sections above say, a resource type carries its `capabilities` (`host`, `database` and `wakeup` from its spec, `source` for a type a host type's `source` field names, such as `github.repository`), a vendor its `credentials` (each variable its driver's `env` declares: its name, description and whether it is optional, never a value or a status), and the policy its `files` (each `.cedar` file's path and text, the root's then each app's).

  It is a separate entry so the worker never loads the parser the outline uses, and the lint refuses it in workflow files. `resolveConfig(config)` returns the checked config as a `ResolvedConfig`, with the operations and drivers by id, the resource types by `<vendor>.<type>` (`types`), the workflows by name (the built-ins `drift`, `apply` and `call` among them), its `root` and each vendor's `credentials` (`CredentialStatus`); `isOp(x)` tells an operation from a built-in in a workflow's `uses`.
- `readSites(root, description, connectors, policies?)` in `sanoma/workflows/describe` returns the `sites` entries that `describeConfig` includes. Use these entries to show which pages use a workflow.

### Site descriptions

A site is a folder under `sites/` with a URL-segment name and a `routes/` directory. Sanoma loads `site.ts` and parses the site’s TypeScript and TSX with oxc. It includes `routes/**`, `components/**`, and other site files, skipping tests, specs, and stories outside `routes/`. It reads browser code without running it.

| Site information | What it describes |
| --- | --- |
| `SiteEntry.name` and `title` | The folder name and the title from the default `defineSite({ title })` export. A Zod schema checks the options. An unknown key or invalid field, such as a numeric `icon`, is a problem. Valid fields still apply. An invalid `public`, `login`, or `locales` drops all three. The login must name a login implementation. Locales must be language tags on a public site without a login. |
| `pages` | One `SitePage` per distinct route path, including a layout and its index as one path. Files or directories starting with `-` are excluded. |
| `calls` | Each `SiteCall` records `kind`, `target`, `method`, `via`, `file`, `line`, and `column`. In a page file, `page` is the path from its `createFileRoute` or `createLazyFileRoute` ID. |
| `warnings` and `problems` | Warnings identify pages the sitemap cannot enumerate. Problems identify invalid or forbidden calls and fail `sanoma check`. |

**Recognized calls.** The parser follows `<RunForm workflow="…" />` and `api` imports from `sanoma/site`, including methods passed to another function such as `queryFn: api.data.leads.list`. The paths `api.<name>` and `api.<name>.<method>` identify a workflow by `apiNameOf`. Collection calls use `api.data.<collection>.<op>`. Vendor calls use `api.<vendor>.<resource>.<op>`. The method is recorded as written, such as `start`, `latest`, or `list`.

**Content and prerendering.** For a path with one parameter, such as `/sites/www/blog/$slug`, the page’s `content` field identifies the kind read by `content.<kind>.get(params.slug)` or its destructured `slug` equivalent. The build uses `siteContentPages(root)` to map paths to kinds for the sitemap and page languages. A public page that reads content but does not use its parameter this way produces a warning and has no entries listed in the sitemap.

A page’s `SitePage.calls` is `true` if its files, a parent layout, or any site file they import transitively might make a call. `buildAppBundle` in `sanoma/app/bundle` skips prerendering such pages. A computed member, variable, template with substitutions, namespace import, or destructured `api` can mark a page as calling even when analysis cannot identify its target.

**Validation.** Sanoma reports a call to a missing workflow, collection, or operation (for example, `calls workflow "<name>", which does not exist`), or to an operation ineligible for a direct call. When policies are valid, `describeConfig` passes them to the analysis. For a public workflow start (`api.<name>(…)`, `.start(…)`, or `RunForm`) or direct call, at least one company `permit` must be able to admit a visitor. Analysis considers `anonymous` and, on a site with a login, the `visitors` group.

It ignores `when` and `unless` for this check. The error gives the permit to add. Regardless of policy, visitors cannot call built-in workflows or inspect workflow runs through `.latest`, `.runs`, `.approvals`, or `.ledger`. They can use `.result`.

### Generated API and runtime clients

- `generateApi(description)` and `writeApi(root, description)`, from `sanoma/workflows/describe`: a site's typed `api`, `.sanoma/api.ts` (`API_FILE`), from a `ConfigDescription`, types and JSDoc only and the same text for the same description. It holds a record type per collection and `CompanyApi`: `<apiNameOf(workflow)>: WorkflowFn<input>` per workflow, built-ins too; `<vendor>: { <resource>: { <op>: OpFn<input, output> } }` for the operations `direct` marks; `data: { <collection>: CollectionApi<record> }`; each member documented from its title or description.

  Then it augments `sanoma/site`'s `Register`. Inputs, records and an operation's output are typed from their JSON Schema for the kinds a start form draws, constants, a record's values, tuples, and unions of them (`null` among them, and a discriminated union). An operation's output also reads a `$ref` to a resource type's state as that state (an input's is `unknown`), and adds `undefined` when the output is optional. Anything else (a file, a date, a transform's result), a workflow's output and the output of an operation that declares none, is `unknown`.

  An optional value inside an array or a record is typed without its `undefined`, which JSON Schema cannot say. A workflow with `describeConfig`'s api-name problem is left out (`problems`). `writeApi` writes only when the text differs (`wrote`).
- `SanomaClient`: call an operation directly (`call`, see [Direct calls](/workflows/direct-calls/)), start runs, list them (`runs({ limit, status, workflow })`) or read a workflow's last result (`latest`), read a run's ledger and approvals, decide approvals, with the checks described above, and start a drift check or an apply and read its report (`drift`, `driftReport`, `apply`, `applyReport`, see [Drift](/workflows/resources/#drift) and [Apply](/workflows/resources/#apply)).

  `client.chats` keeps the operator agent's chats in the config's database: `open({ id, person, engine, title })` (the id the browser gave the new chat), `attach(id, draftId)`, `upsert(id, messages)` (the AI SDK's UI messages, each by its id, a new one after the last), `load(id)`, `get(id)` and `list(person)` (the newest first, `Chat`).
- `APPROVALS_EVENT` and `decisionEventOf(approvalId)`: the DBOS events a run publishes its approvals and each decision on, for a UI that reads DBOS directly. `ApprovalMessage` is the zod schema of a decision as a run reads it. `RunArgs` is what a run receives: its input, `startedBy` and, for a sandbox run, its scenario as `sandbox`.
- `mayDecide(approval, principal, run, people)` and `approverLabel(approver)`: who may decide, and how to name them, the same way the run does. `isEnded(status)` and `ENDED_STATUSES`: the run statuses that read no more decisions; `RUN_STATUSES`: every run status, in the order a run may pass through them.
- Errors: `errorCode(err)` for the code to branch on, `errorMessage(err)` for the text of anything thrown, `invalidInput(what, issues)` to build an `invalid_input` error from zod issues (`InputIssue` is one issue, without symbols in its path), and the classes `SanomaError`, `PolicyDeniedError`, `RejectedError`, `WithdrawnError`, `ApprovalPendingError` and `DriverError`. Read codes with `errorCode`, never `instanceof`.
- `sanoma/workflows/shared` exports `mayDecide`, `approverLabel`, `errorMessage`, `isEnded`, `ENDED_STATUSES`, `RUN_STATUSES`, `DRIFT_WORKFLOW`, `CALL_WORKFLOW`, `isLoopback` (whether a host is this machine: `localhost`, `127.x.x.x`, `::1`), `problemAt` (a problem's place: `file:line:column`, else `file#export`, else `file`), `problemLine` (a problem as one line: its place, then `: message`, or the message), `exportSpan` (where `export const <name>` or `export default` is in a file's text, for marking a declaration), `credentialReady` (a variable is set, or optional and unset) and the `RunStatus` and `CredentialStatus` types, the resource types' types (`Resource`, `ResourceSpec`, `ResourceFields`, `References`, `FieldReference`, `Declared`, `Declaring`, `DeclaredResource`, `ResourceProblem`) and the drift report's (`DriftReport`, `DriftResult`, `DriftField`, `DriftStatus`), with nothing else: no DBOS or Node imports, so a browser bundle can use them.

  The main entry exports them too.
- `LedgerRecord` and `LedgerStore` for the audit record (`LedgerBody` is a record without the fields every record carries, and `LedgerGroup` a record's `ctx.all` tag), `postgresLedger(databaseUrl)` (the default), `jsonlLedger(dir)` and `memoryLedger()` to keep it, and `RUNTIME_VERSION`, this package's version as the runtime reports it.

## Outline

`outlineWorkflow(wf)`, from `sanoma/workflows/describe`, reads a workflow's shape from the file that defined it, for drawing it before it runs, and the worker holds every run to it, so the drawing is what a run can do and nothing else. `describeConfig` returns it as each workflow's `outline`:

```ts
import { outlineWorkflow } from "sanoma/workflows/describe";

outlineWorkflow(announce);
// { nodes: [{ kind: "op", path: "0", id: "ghost.post.create", span: [913, 974] }, …, { kind: "approval", path: "2", title: "Review launch copy", span: […] }, …], file: "/…/workflows/announce.ts" }
```

It parses the file with oxc-parser (TypeScript in a repo, `.tsx` included, JavaScript once built) and lists, in the order they run, the calls `run` makes on its first parameter, whatever it is named: operations (`op`, with a `*` for a computed segment such as `ctx[vendor].comments.list`, as the built-in `drift` imports each resource by its type, with the step's `name`), approvals (with the title, when it is a string literal or a top-level `const` holding one), sleeps (with their `name`), and `ctx.all`: `all` with one branch per member of an array literal, or for anything else, such as `ids.map(…)`, `each` with the callback's calls as its `body`.

Around them it shows loops and `.map`, `.forEach` and `.reduce` callbacks as `repeat`, `if`, `switch`, `?:`, `&&`, `||` and `??` as `branch` (one case per arm that makes calls, plus one empty case for the way past them when there is one: an arm without calls, an `if` without `else`, a `switch` without `default`, the right side of `&&` not run), and `try` / `catch` as `try`, with the handler's calls as `handler`; a `finally` is not read.

It does not read the functions `run` calls, whether defined outside `run` (a helper that takes `ctx`) or inside it, only callbacks passed to `ctx.all`, `.map`, `.forEach` and `.reduce`, and it cannot see how many times a loop runs or which arm is taken: the ledger says that, per run.

Each loop, and each `each`, has a `label` read from its code: `for each of subscribers` for `for (const s of subscribers)` or `subscribers.map(…)`, `for each key of` for `for…in`, `repeat while queue.length` for a `while`, `do` or `for` with a test, and `repeat` for one without (the code on one line, cut at 40 characters). A loop's label is no step's name, and need not be unique.

### Connecting an outline to a run

Each node's `path` is its place in the outline: its index among its siblings, under its parent's path and the index of the branch, case or body it is in (`"2"`, `"2.1.0"`), the same for the same tree however the code is laid out. Each node's `span` is where its code is in the file, as UTF-16 offsets (a string index, and what CodeMirror counts): the call, the `ctx.all(…)`, the loop or `.map(…)` call, the whole `if` / `else` chain, `switch`, `?:` or `&&`, or the `try` statement.

`describeConfig` puts the file's text beside the outline, as the workflow's `source`, with `\n` line endings; a server can keep that from its clients, since it is a whole file.

`defineWorkflow` records the file it is called from as the workflow's `file`, by itself; nothing passes it, and a definition made from code with no file (an eval, a bundle without one) is refused. The outline is read from that file, which must hold the workflow as an object literal with its `name` (a string literal, or a top-level `const` of the file holding one) and a `run` function taking `ctx` by name; otherwise it is `{ error }`, saying why (the file could not be read or parsed, holds no workflow of that name, or `run` destructures `ctx`).

It is `{ error }` too, one line per problem at `file:line:column`, when `run` holds what the graph cannot draw: the control flow and uses of `ctx` that `lintWorkflow` refuses (see [Keeping workflows replay-safe](/workflows/replay-safety/)). Either way `startWorker` refuses the config, since nothing could say where the workflow's calls are.

The worker reads each workflow's outline when it starts and holds every run to it. Each `ctx` call captures where the workflow made it, from the stack, and the worker finds the call node whose code holds that position; a call from anywhere else fails the run with `call_not_in_outline`, naming the file, line and column and what to do (inline the helper): from a function the outline does not read, from another file, from a `finally`, or through an alias (`const create = ctx.ghost.post.create`).

`ctx.now()`, `ctx.runId` and `ctx.startedBy` are exempt: a read of the clock, and values. The records a call writes name its node as `node` (its `path`): `op.called`, `sleep.started`, `approval.requested` (a policy hold's approval names the held call's node) and each `group` of a `ctx.all`, so a UI places a run's steps in the code exactly, a loop's every pass on its one node. Records written by a worker from before calls were placed have no `node`.

Status: early (0.x). The API may change between minor versions.

TODO: redact fields a schema marks `.meta({ sensitive: true })` from the ledger, the approvals event and DBOS's step records, so a secret passed by mistake is not kept.

## Runs in a page

`sanoma/workflows/page` runs a company's workflows inside a browser page, the base of a static demo: `await pageRuntime({ workflows, collections?, connectors?, world?, actor?, decide? })`. Every vendor is its connector's fake and every collection is in memory, so no email, charge or post leaves the page.

`world` is the world every run starts from (`loadWorld`'s, from `scenarios/world.feature`): its `Given` steps applied to the fakes as a sandbox run's are; `reset()` makes the fakes again and seeds them, and drops the runs; `stop()` drops the runs alone (a demo's unmount): a sleeping run's sleep fails with `run_ended`, its timer cleared, and a dropped run's next operation, approval, sleep or `ctx.all` never settles, so it goes no further and its `.result` stays unanswered; until a `reset`, a run started after `stop()` stops at its first call.

There is no DBOS, no policy and no store: each approval a run asks for is decided at once, approved unless `decide(approval)` says `"reject"` (the run then fails with `approval_rejected`).

`ctx.sleep` waits as a worker's does, on a timer of the page's: the run stays at its `sleep.started`, `running` (as the app reports a sleeping run), until the time it names, and `.result` with `waitMs` answers `run_running` meanwhile.

`transport(request)` answers what the app's `callApi` does for a site's `api`, so `createApi(transport)` gives a page the same `api`: an operation a person may call directly, on its fake; `<workflow>` or `<workflow>.start` (`{ runId }`); `.result` (the run's output once it ends, or its failure); `.latest`, `.runs`, `.approvals`, and `.ledger`, the run's records (`LedgerRecord`, each with the step's name, an operation's input and output, a sleep's `until`) for a run card.

Its failures are the runtime's errors (`errorCode`), not the app's responses. A page's build gives a connector's module its package's `vendorInfo` (`vendorInfos()` from `sanoma/app/bundle`, as the Worker's build does) and names each company file from the root (`companyFiles(root, { fromRoot: true })`), which the page reads a collection's app from.
