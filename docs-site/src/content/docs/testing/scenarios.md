---
title: Scenarios and sandbox runs
description: "A scenario is a Gherkin feature file that says what a sandbox run starts from, how its approvals are decided and what it should do."
sidebar:
  order: 1
---

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

| Keyword | Step                                                                                     | What it does                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Given   | `{op} was called with` and a JSON doc string or a two-column table (`name \| value`)     | Seeds the fake: calls the operation through it before the run                                                                                                                                                                          |
| Given   | `{op} fails once`, `{op} is rate limited once`, `{op} loses its reply once`              | Injects the fault into the operation's next call (`failNext`, `rateLimit`, `loseReply`); its step has `fault: true`                                                                                                                    |
| Given   | `{resource} {string} has` and a two-column table (`field \| value`) or a JSON doc string | The vendor's fake holds the object with these fields: `Given github.repository "website" has` then `\| has_wiki \| true \|`                                                                                                            |
| Given   | `{resource} {string} is gone`                                                            | The vendor's fake no longer holds the object: `Given github.repository "docs" is gone`                                                                                                                                                 |
| Given   | `{who} is acting`                                                                        | Starts the run as that declared person or agent, or `anonymous`: `Given refund-bot is acting` (else `runScenario`'s `startedBy`, `scenarios` by default)                                                                               |
| Given   | `a visitor is acting`                                                                    | Starts the run as a visitor of a public site signed in (`visitor:scenario:visitor`, in `visitors`), which only a `permit` lets start one                                                                                               |
| Given   | `a visitor {string} is acting`                                                           | The same visitor with the email its login verified: `Given a visitor "hopper@example.com" is acting` (`ctx.startedBy.email`)                                                                                                           |
| Given   | `a visitor {string} with GitHub {string} is acting`                                      | The same, with the GitHub login it signed in with or linked too: `Given a visitor "hopper@example.com" with GitHub "hopper" is acting` (`ctx.startedBy.github`)                                                                        |
| Given   | `an api token {string} for {string} is acting`                                           | Starts the run as an api token of a public site's api acting for that subject (`token:<id>`, in `visitors`), with no row in the database: `Given an api token "cli" for "visitor:better-auth:ada" is acting` (`ctx.startedBy.subject`) |
| When    | `{workflow} runs with` and a JSON doc string or a two-column table (`name \| value`)     | The workflow the scenario runs, and its input                                                                                                                                                                                          |
| When    | `{workflow} runs with exactly` and a JSON doc string or a two-column table               | Uses only the supplied input, parsed by the workflow schema; omitted optional fields stay absent and schema defaults apply                                                                                                             |
| When    | `{workflow} runs`                                                                        | The same, with the input made up                                                                                                                                                                                                       |
| Any     | `{string} is approved by {who}`, `… with note {string}`, and the `rejected` forms        | How the approval with that title (or id, such as `approval-2`) is decided                                                                                                                                                              |
| Then    | `{op} was called with` and a JSON doc string or a two-column table                       | Expects a call whose input has at least these fields, at any depth: an object may give some of its fields                                                                                                                              |
| Then    | `{op} was called`, `{op} was not called`                                                 | Expects a call to the operation, or none                                                                                                                                                                                               |
| Then    | `step {string} was called with` and a JSON doc string or a two-column table              | Expects a call by the [step](/workflows/built-ins/#step-names) of that name whose input has at least these fields, at any depth: `Then step "Draft the post" was called with`                                                          |
| Then    | `step {string} was called`, `step {string} was not called`                               | Expects the named step to have run, or not                                                                                                                                                                                             |
| Then    | `step {string} ran {int} time(s)`                                                        | Expects the named step to have run that often: `Then step "Draft the post" ran 2 times`                                                                                                                                                |
| Then    | `{op} was denied`                                                                        | Expects the policy to have denied a call to it: `Then github.repository.import was denied`                                                                                                                                             |
| Then    | `{op} was denied with {string}`                                                          | The same, with that reason (a Cedar policy's `@reason`): `Then shop.refunds.create was denied with "Agents do not refund"`                                                                                                             |
| Then    | `{op} was held for {who}`                                                                | Expects an approval for that approver to have held it: `Then stripe.product.import was held for finance`                                                                                                                               |
| Then    | `{op} was held for group {string}`                                                       | The same, for the group alone, never a person of that id: `Then shop.refunds.create was held for group "finance"`                                                                                                                      |
| Then    | `{declared} is drifted in {field}`                                                       | For a drift run: `Then resources/identity/github.ts#website is drifted in has_wiki`                                                                                                                                                    |
| Then    | `{declared} is clean`, `{declared} is gone`, `{declared} is absent`                      | For a drift run: `Then resources/identity/github.ts#docs is clean`                                                                                                                                                                     |
| Then    | `apply creates {declared}`                                                               | For an apply run: it created the resource (or made a gone one again): `Then apply creates resources/identity/github.ts#docs`                                                                                                           |
| Then    | `{declared} is bound to {string}`                                                        | For an apply run: the lockfile it ended with binds it so: `Then resources/identity/rules.ts#docsMain is bound to "BPR_docs:main"`                                                                                                      |
| Then    | `the run succeeds`, `the run fails`, `the run fails with {string}`                       | Expects the run to finish, or to fail (with that error code, such as `"approval_rejected"`)                                                                                                                                            |

A resource step names an object a vendor's fake holds, by resource type and import id (a binding id, or the provider's import id: a GitHub repository's name without its owner, a branch protection rule's `repository:pattern`; a fake also finds an object by its binding id, such as a repository's `node_id`), for a fake that holds objects (`sanoma/internal/bridge`'s `tfFake`, as the GitHub and Stripe fakes are; a sandbox run whose scenario seeds a resource of another vendor's fake fails with `invalid_input`). `has` puts the fields on the object (`put`: over the one the vendor has, keeping its other fields, or a new one), each read as a table cell is for an operation's input and checked against the type's schema; `is gone` removes it (`remove`), and is nothing when there is none. The run's own fake is what is seeded. A fake starts a sandbox run with what its replies were recorded with, so a declared resource the recording lacks is `gone` to a drift run until a scenario puts it.

The policy steps read the run's ledger: `was denied` holds when the policy's decision on some call to the operation is `deny`, and `was held for {who}` when an approval addressed to that person (by id) or group (by name) holds it, whether the policy asked for it on that call or the workflow asked for one that `covers` it. A failed step says what happened instead: `github.repository.import was allowed, not denied`, `stripe.product.import was held for finance, not marketing-lead`, `shop.refunds.create was denied with "Agents do not refund", not "No"`. When the data files declare people, `is acting` names a declared person or agent (one of the runtime's own too, or `anonymous`) and `held for group` a declared group, `agents` or `visitors`, else the scenario does not load, naming those declared; while they declare no one, any id and any group go, as a run's start admits anyone then. A scenario has one actor. The drift steps read the report a finished [drift](/workflows/resources/#drift) run returned, so their scenario must run `drift` (a parse error otherwise), as the apply steps read an apply run's report, and an apply run's input is only what `runs with` gives, never made up; a failed one says how the report found the resource: `resources/identity/github.ts#website is drifted in has_wiki, not clean`, `… is gone, not drifted in has_wiki`, or that the report has no such resource.

The `step` steps name a [step](/workflows/built-ins/#step-names) of the scenario's workflow, after its `When`: one whose name is no step's, or several's (a default an operation called twice shares), is an error listing the names it has, so a test names one call (an unnamed call with a computed segment, `ctx.ghost.post[action](…)`, is named in a run by the operation it calls, so it shares that operation's id; an approval whose title is no literal is named by its title in a run, which the outline cannot tell apart), and `was called with` checks its operation's input fields. They read the ledger by the `name` its records carry: a step ran when a call by it was made (not denied, rejected or failed for good), a sleep by it started, or the workflow asked for an approval of that title; a policy's hold on a call is that call's, not a run of its own. A call in a loop runs once per pass: `ran 3 times` for three items. A failed one says what happened: `step "Draft the post" ran twice, not 3 times`.

Cucumber matches a step by its text alone, whatever its keyword; Sanoma then picks the step of that keyword, so `{op} was called with` seeds after `Given` and expects after `Then`. Two different expressions matching one step's text is ambiguous whatever their keywords.

Each scenario has exactly one `When … runs`. An operation can add its own steps with `phrases` in its spec: `{ given: "a post titled {title} exists", expect: "a post titled {title} is created" }`. Each `{name}` is a field of the operation's input (a phrase naming another is a configuration error); it matches what `{string}` does (a quoted string) or one word, and is read as a table cell is. A field may have any name, even one a parameter type has (`op`, `string`, `int`): the phrase reads it as the field. A `given` phrase seeds the fake as `was called with` does, and an `expect` phrase (for `Then` steps) expects a call with those fields. `describeConfig` lists them as an operation's `phrases`.

A doc string is a JSON object. A table cell, and a phrase's field, is read as text when its field takes text, else as JSON (a number, `true`, a list): `| title | 123 |` is the text `"123"` for a string field, and `| count | 5 |` the number 5 for a number field. Every field a doc string or a table names must be one the input has (the error lists those it has), and its value one the field takes; a value it takes neither as text nor as JSON, such as `yes` for a boolean, is an error. A `Then` checks each field it names this way, not the whole input, and at any depth: an object it gives (in an object field, optional or nullable too) may name some of its fields (`{ "record": { "stage": "won" } }`), each checked against its own schema (`stage in record in data.outbound.save's input cannot be …`), where a `Given`, which seeds a call, needs the whole object; a list, and an object in a list or a union, is given whole. So does an `expect` phrase's field.

`runs with` and `runs` make up omitted workflow input from the schema with [zod-schema-faker](https://github.com/soc221b/zod-schema-faker), seeded from the scenario's name, so one scenario always makes up the same values; it is then parsed by the schema. Use `runs with exactly` to test omitted optional inputs or schema defaults: it parses only the supplied JSON object or table, without generating values. A missing required field is a scenario compilation error. For example, `When cloud-signup runs with exactly` can omit an optional `installation` to exercise the workflow's missing-installation path. A step no rule matches, or more than one, an unknown operation, workflow or field, a value its field does not take, a missing or second `When`, a doc string that is not JSON, and a file Gherkin cannot parse are errors naming the file and line; the first lists every step there is, each operation's phrases under its id and each connector's steps under its vendor. A file with an error has none of its scenarios; the other files still load.

Checking a run, every `Then` step runs and judges the run on its own: one that does not hold says why, and the steps after it are still checked.

## The world

`scenarios/world.feature` at the root is the world: the company a demo opens on, written as one scenario of `Given` steps alone. It uses the same steps as any scenario, so it can describe a collection's records, the objects a vendor's fake holds and the calls a fake has had (`{op} was called with`). Sanoma reads and checks it; nothing applies it yet.

```gherkin
Feature: The company a demo opens on

  Scenario: Acme's books
    Given data.clients "acme" has
      | name | Acme Corp |
    And github.repository "website" has
      | has_wiki | true |
```

The world is not a scenario: nothing runs or checks it, and the list of scenarios leaves it out. Its file holds exactly one `Scenario`. A `Scenario Outline`, a second scenario, a `When`, a `Then`, a fault, a decision or a step saying who is acting is refused at its line, and `sanoma check` reports that as it reports any feature file that does not load. Only the root has a world: a `world.feature` in an app's `apps/<app>/scenarios/` is an ordinary feature file, whose scenarios each need a `When`.

`loadWorld(scope)`, from `sanoma/workflows/scenario`, resolves to the world's `{ name, given }`, or `undefined` when the root has no `scenarios/world.feature`, and rejects with its error at its `file:line`. `loadScenarios` returns it too, as `world`, with its error among `errors`.

## Steps a connector ships

A connector's package declares steps with `defineSteps(vendor, ({ given, then }) => …)` (from the main entry) and attaches them with `withSetup(ops, { driver, fake, steps })`; a company passes its own as the config's `steps`. A step is a Cucumber expression (with the built-in parameter types, `{string}`, `{int}`, `{word}` and the rest) and a pure function of its parameters' values: compiling calls it, the app too, whenever a feature file changes.

```ts
import { defineSteps } from "sanoma/workflows";

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

The same steps test the connector's own operations, in its `features/`: there the generic steps below call an operation directly (no worker, no policy) on a fake or on the driver over recorded replies, and `$name.field` in a table cell is a field of what a `Given` named `as` returned (`| id | $draft.id |`). A `Given` that calls a resource type's `create` seeds the object as apply makes it: the type's `afterCreate` calls follow, each polled as apply polls it (a Neon project's compute has started), the seed's name (else the type's) as the export a `storeUrl` stores under. [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/testing/README.md#a-connectors-own-features) runs them.

| Keyword | Step                                                              | What it does                                                                                     |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When    | `{op} is called with` and a JSON doc string or a two-column table | Calls the operation with that input, the rest made up; the call and its output or error are kept |
| Then    | `it returns` and a two-column table of fields of its output       | Expects the last call to have returned at least these fields, at any depth                       |
| Then    | `it fails with status {int}`                                      | Expects the last call to have failed with that vendor status                                     |

A workflow's scenario refuses `{op} is called with`, and an operation's own test refuses a step that runs a workflow, decides an approval or seeds a resource; a fault needs the fake.

`sanoma/workflows/scenario` (server-side only; the lint refuses it in workflow files) compiles and checks them:

- `loadScenarios(resolveConfig(config))` resolves to `{ scenarios, errors }`: every scenario, compiled by Cucumber, and an error for each file that does not compile or name used twice. It reads the resolved config's `ops`, `workflows`, `types`, `steps` and `scenarios` (the directory). A scenario's `line` is its keyword's, or its examples row's. A scenario's `text` is its own lines of its file, for display: from its keyword line to the end of its last step (doc strings, tables and an outline's examples included), less that line's indent; its `steps` are each `{ text, kind, op?, name?, called?, decision?, fault? }`, in order: `op` names the operation a step is about, `name` the step a `step "…"` Then is about, `called` says whether a `Then` about either expects a call (or a run) or none (`ran 0 times` too), `decision` that it expects the policy to have denied it (`denied`) or held it (`held`), and `fault` marks a `Given` that injects a fault rather than seeding. It compiles the files again only when one has been added, removed or written since its last call with that config (a file's name, `mtimeMs` or size changed); until then it resolves to the same object, so the worker and the app can call it on every run and every request. Compiling builds Cucumber's support library from the config (once per resolved config) and runs the files: a few milliseconds.
- `check(scope, scenario, records)` runs the scenario's `Then` steps, as its feature file reads now, against a run's ledger records, and resolves to `{ step, ok, detail? }` for each expectation, in order; it rejects when the file no longer has the scenario as it was compiled (load the scenarios again first). Each `Then` is judged on its own, so one that does not hold leaves the rest checked. For the generic steps: a call matches when its parsed input contains the expected input (every field, at every depth); a call is an `op.called` record without an `error`, so one the policy denied, an approver rejected or the vendor failed for good was attempted, not made (`was not called` passes, and a failed `was called` lists the attempts in its `detail`); a denial is read from the `op.called` records' `decision`, a hold from `approval.requested` (its `op`, or its `covers`); a named step's runs from the `name` on the `op.called` (made), `sleep.started` and workflow-asked `approval.requested` records; an outcome is read from `run.finished` or `run.failed` (`ok: false`, "run not ended", before either); and a drift result from the `DriftReport` a `run.finished` holds as its `output`. A connector's or the company's `Then` whose `check` throws fails with the error's message.
- `testFeature(scope, file, line, { driver, fake? })` runs one scenario of a connector's own feature file as an operation's test, rejecting with its first step that did not pass at its `file:line`, and `featureScenarios(scope, dir)` lists a directory's scenarios from a dry run: what `describeFeatures` is built on.
- `drive(client, runId, scenario, { timeoutMs? })` decides the run's approvals as the scenario says until the run ends, and returns its `RunSummary`. Each pending approval takes the decision naming its title or id, else the next decision left that names no approval of the run: none it has asked for, and none in `scenario.approvals`, the titles its workflow's code asks for where they are string literals (read from its [outline](/workflows/your-own-ui/#outline)). So `"the first one"` is decided in order, but a decision for `"Final check"` is never spent on the approval before it. An approval with no such decision throws, naming the decisions left. Each decision waits for the run to read it until the timeout; a worker that has not read it by then throws `run_running`, as does a run still going. `by` is a person's id, so a scenario cannot decide an approval addressed to a group.

Start a sandbox run with `client.start(workflow, input, { startedBy, sandbox: "<scenario name>" })`. `sandbox` must be a non-empty string, else `start` throws `invalid_input`; the worker looks the scenario up. The input is the caller's (a scenario's own is `scenario.input`). The worker then:

- parses the input, then seeds its own fakes from the scenario, once, in a step named `sandbox:seed`: it reads the scenario, makes a fake of every vendor for the run (each maker, called once), checks the scenario against them, calls each `Given` operation through its fake, puts or removes each `Given` resource in its fake, and injects the faults into them. It records `scenario.seeded` (the scenario, and each seed: an operation's with its input and output, a resource's with its type's id, its import id and its fields, or `gone: true`) right after `run.started`. A scenario that does not exist or runs another workflow, a workflow using (or a scenario seeding) an operation with no fake, a scenario seeding a resource of a vendor whose fake holds none, and a resource seed the fake refuses (a field its provider's shape lacks), fail the run with `invalid_input`, the last naming the step.
- calls its own fakes, never a driver, under the same policy and approvals as a live run.
- does not wait on `ctx.sleep`: it still records `sleep.started` with the real `until`, and goes straight on.
- runs it on the app's queue, as any run: sandbox runs share no fakes, so several run at once, and one waiting on an approval holds up no other.
- checks it against its scenario as it starts to wait on an approval and once it ends (its outcome recorded, before DBOS records it): Cucumber runs the scenario's `Then` steps over the feature file as it reads then, against the ledger so far, and the answers (`RunChecks`: each `Check` with whether it is `settled`, or why there are none) go to the runtime's table, which `client.runChecks(runId)` reads. No step and no ledger record: what the run does never depends on them.
- prints nothing of it through DBOS's log: none of DBOS's warnings from inside it (a step's failed try among them: a fake's `fails once` is on purpose), nor the error the run fails with. Its ledger and its status say what happened; a live run's tries and failures print as ever.

A sandbox run does not survive a worker restart: its fakes keep their state in the worker's memory, so a run whose seeding DBOS replays from its checkpoint (after a restart, or in a fork) fails with `invalid_input`, "Sandbox run … was interrupted by a worker restart and the fakes' state is gone; start the scenario again", rather than going on against fakes in some other state.

`RunSummary.sandbox` names the scenario a sandbox run was seeded from (kept in DBOS's `attributes` for the run). Reusing a run id with another `sandbox`, or none, is `invalid_input`, as with another input.

`runScenarios(config, { databaseUrl, startedBy?, timeoutMs?, log? })` from `sanoma/workflows/scenarios` (server-side only, like `/scenario`) runs every scenario of the config as a sandbox run, on a worker it starts on `databaseUrl` with an in-memory ledger and stops after, and returns `{ passed, failed }`: the names of the scenarios whose every check held, and one `{ scenario, step, message }` per step that did not (with `check`'s detail), per run that could not be driven to its end (at its `When` step), and per feature file that did not load (`step: "did not load"`); a config whose root has no `scenarios/` passes and fails nothing. `sanoma check` runs it. `startedBy` (an id or a principal) starts each run whose scenario does not say who `is acting`. `runScenario(scenario, { client, scope, startedBy?, timeoutMs? })` runs one against a worker you started, `scope` being what it was loaded from (the resolved config). To run them as tests, a vitest test each, use `describeScenarios` from [`sanoma/testing/scenarios`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/testing/README.md#scenarios), which wraps the same `runScenario`.

## Scenarios

`sanoma/testing/scenarios` runs a config's [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#scenarios-and-sandbox-runs) as vitest tests (install `vitest` and `@dbos-inc/dbos-sdk` beside it). Each scenario is a sandbox run: the worker calls fakes of its own, made by the makers the connectors carry, never a driver.

`describeScenarios(config, options)` compiles the `.feature` files in `scenarios/` in the config's root and in each app's `apps/<app>/scenarios/` with Cucumber, each named by its path from the root (`scenarios/x.feature`), so a test file awaits it at its top level, and registers a test for each scenario, in a `describe` per file, each over `runScenario` from `sanoma/workflows/scenarios` (the one implementation; `runScenarios` there, which `sanoma check` runs, needs no vitest); it throws, naming the root or the directory, when neither the root nor an app has a `scenarios/` or they hold no scenarios and no world. The world (`scenarios/world.feature`, which seeds a [demo](/sites/demos/)) is a test of its own, named after its file: its Givens seeded on the connectors' fakes, as a demo's page seeds them. A test starts the scenario's sandbox run, decides its approvals as the scenario says, and fails listing each `Then` step that did not hold, with why (each judged on its own). A file that does not load (a step no rule matches, bad JSON, a name used twice) is a failing test named after the file, whose message names the file (and the line, for a step or JSON error). It starts one [test app](/testing/workers/#a-test-app) for all its scenarios, before them, with `useTestApp(config, options)`, and stops it after, on `options.databaseUrl`, as for `startTestWorker`. `options.startedBy`, an id (`"ada"`) or a principal, starts the runs whose scenario does not say who `is acting` (default `scenarios`), and `options.timeoutMs` is how long each may take (`drive`'s, 15 seconds by default); the tests it registers get twice that, so `drive`'s error is the one you see.

```ts
// test/scenarios.test.ts
import { testDatabaseUrl } from "sanoma/testing";
import { describeScenarios } from "sanoma/testing/scenarios";
import { memoryLedger } from "sanoma/workflows";
import config from "../sanoma.config.ts";

await describeScenarios({ ...config, ledger: memoryLedger() }, { databaseUrl: testDatabaseUrl("scenarios") });
```

A config imported this way has the workflows it lists, and no others: `sanoma` finds those of `workflows/` and the apps' when it loads the config, so one that lists none runs its scenarios with `sanoma check`. A company config spread into `describeScenarios` keeps its `ledger`, so pass `ledger: memoryLedger()`, as above, to keep test runs out of the project's ledger.

Besides a run's calls and outcome, a scenario can say what the policy did and, with the vendors' fakes holding what the data files declare, what the built-in [drift](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#drift) check finds (the full list of steps is in the workflows package):

```gherkin
Scenario: A secret repository is refused
  When inspect runs with
    | repository | secret-plans |
  Then github.repository.import was denied

Scenario: A product is read once finance says so
  When inspect runs
  And "Read a product" is approved by finance
  Then stripe.product.import was held for finance

Scenario: A setting changed at GitHub
  Given github.repository "website" has
    | has_wiki | true |
  When drift runs
  Then resources/identity/github.ts#website is drifted in has_wiki

Scenario: A repository GitHub no longer has
  Given github.repository "docs" is gone
  And github.repository "website" has
    | name        | website              |
    | description | The company website  |
    | visibility  | public               |
    | has_wiki    | false                |
    | topics      | ["website", "astro"] |
  When drift runs
  Then resources/identity/github.ts#docs is gone
  And resources/identity/github.ts#website is clean
```

`Given <resource> "<name>" has` and `is gone` change the run's own fake of the vendor before it starts (a GitHub repository by its name, a Stripe object by its id: the resource's import id), for fakes that hold objects, as the GitHub and Stripe ones do; a failed `Then` says what the run did instead (`github.repository.import was allowed, not denied`, `resources/identity/github.ts#docs is gone, not clean`).

`runScenario(scenario, { client, scope, startedBy?, timeoutMs? })`, re-exported from `sanoma/workflows/scenarios`, runs one scenario against a worker you started, with a `SanomaClient` of it, and returns `{ runId, run, ledger, checks }`: the run's id, its summary, its ledger records and `check(scope, scenario, ledger)`. `timeoutMs` goes to `drive`. Load the scenarios with `await loadScenarios(scope)` from `sanoma/workflows/scenario`, `scope` being `resolveConfig(config)`.
