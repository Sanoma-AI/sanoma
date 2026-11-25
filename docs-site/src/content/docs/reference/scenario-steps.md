---
title: "Scenario files and step reference"
description: "Look up Gherkin steps, matching rules, and the format of a demo world."
sidebar:
  order: 7
---

Sanoma reads every `.feature` file under `scenarios/`. Each file must contain a scenario, and names must be unique across the collection. Each example row of a `Scenario Outline` becomes a scenario. If two rows produce the same title, Sanoma appends their line numbers, as in `Launch (line 12)`. A repo without `scenarios/` has no scenarios.

## Scenario step reference

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

### Resources, policy, and actors

A resource step names an object a vendor's fake holds, by resource type and import id (a binding id, or the provider's import id: a GitHub repository's name without its owner, a branch protection rule's `repository:pattern`; a fake also finds an object by its binding id, such as a repository's `node_id`), for a fake that holds objects (`sanoma/internal/bridge`'s `tfFake`, as the GitHub and Stripe fakes are; a sandbox run whose scenario seeds a resource of another vendor's fake fails with `invalid_input`).

`has` puts the fields on the object (`put`: over the one the vendor has, keeping its other fields, or a new one), each read as a table cell is for an operation's input and checked against the type's schema; `is gone` removes it (`remove`), and is nothing when there is none. The run's own fake is what is seeded. A fake starts a sandbox run with what its replies were recorded with, so a declared resource the recording lacks is `gone` to a drift run until a scenario puts it.

The policy steps read the run's ledger: `was denied` holds when the policy's decision on some call to the operation is `deny`, and `was held for {who}` when an approval addressed to that person (by id) or group (by name) holds it, whether the policy asked for it on that call or the workflow asked for one that `covers` it. A failed step says what happened instead: `github.repository.import was allowed, not denied`, `stripe.product.import was held for finance, not marketing-lead`, `shop.refunds.create was denied with "Agents do not refund", not "No"`.

When the data files declare people, `is acting` names a declared person or agent (one of the runtime's own too, or `anonymous`) and `held for group` a declared group, `agents` or `visitors`, else the scenario does not load, naming those declared; while they declare no one, any id and any group go, as a run's start admits anyone then. A scenario has one actor.

The drift steps read the report a finished [drift](/workflows/resources/#drift) run returned, so their scenario must run `drift` (a parse error otherwise), as the apply steps read an apply run's report, and an apply run's input is only what `runs with` gives, never made up; a failed one says how the report found the resource: `resources/identity/github.ts#website is drifted in has_wiki, not clean`, `… is gone, not drifted in has_wiki`, or that the report has no such resource.

The `step` steps name a [step](/workflows/built-ins/#step-names) of the scenario's workflow, after its `When`: one whose name is no step's, or several's (a default an operation called twice shares), is an error listing the names it has, so a test names one call (an unnamed call with a computed segment, `ctx.ghost.post[action](…)`, is named in a run by the operation it calls, so it shares that operation's id; an approval whose title is no literal is named by its title in a run, which the outline cannot tell apart), and `was called with` checks its operation's input fields.

They read the ledger by the `name` its records carry: a step ran when a call by it was made (not denied, rejected or failed for good), a sleep by it started, or the workflow asked for an approval of that title; a policy's hold on a call is that call's, not a run of its own. A call in a loop runs once per pass: `ran 3 times` for three items. A failed one says what happened: `step "Draft the post" ran twice, not 3 times`.

### Matching steps and inputs

Cucumber matches a step by its text alone, whatever its keyword; Sanoma then picks the step of that keyword, so `{op} was called with` seeds after `Given` and expects after `Then`. Two different expressions matching one step's text is ambiguous whatever their keywords.

Each scenario has exactly one `When … runs`. An operation can add its own steps with `phrases` in its spec: `{ given: "a post titled {title} exists", expect: "a post titled {title} is created" }`. Each `{name}` is a field of the operation's input (a phrase naming another is a configuration error); it matches what `{string}` does (a quoted string) or one word, and is read as a table cell is. A field may have any name, even one a parameter type has (`op`, `string`, `int`): the phrase reads it as the field.

A `given` phrase seeds the fake as `was called with` does, and an `expect` phrase (for `Then` steps) expects a call with those fields. `describeConfig` lists them as an operation's `phrases`.

A doc string is a JSON object. A table cell, and a phrase's field, is read as text when its field takes text, else as JSON (a number, `true`, a list): `| title | 123 |` is the text `"123"` for a string field, and `| count | 5 |` the number 5 for a number field. Every field a doc string or a table names must be one the input has (the error lists those it has), and its value one the field takes; a value it takes neither as text nor as JSON, such as `yes` for a boolean, is an error.

A `Then` checks each field it names this way, not the whole input, and at any depth: an object it gives (in an object field, optional or nullable too) may name some of its fields (`{ "record": { "stage": "won" } }`), each checked against its own schema (`stage in record in data.outbound.save's input cannot be …`), where a `Given`, which seeds a call, needs the whole object; a list, and an object in a list or a union, is given whole.

So does an `expect` phrase's field.

`runs with` and `runs` make up omitted workflow input from the schema with [zod-schema-faker](https://github.com/soc221b/zod-schema-faker), seeded from the scenario's name, so one scenario always makes up the same values; it is then parsed by the schema. Use `runs with exactly` to test omitted optional inputs or schema defaults: it parses only the supplied JSON object or table, without generating values. A missing required field is a scenario compilation error.

For example, `When cloud-signup runs with exactly` can omit an optional `installation` to exercise the workflow's missing-installation path. A step no rule matches, or more than one, an unknown operation, workflow or field, a value its field does not take, a missing or second `When`, a doc string that is not JSON, and a file Gherkin cannot parse are errors naming the file and line; the first lists every step there is, each operation's phrases under its id and each connector's steps under its vendor.

A file with an error has none of its scenarios; the other files still load.

Sanoma checks every `Then` independently. A failed assertion reports why it failed. The remaining assertions still run.

## Policy and drift examples

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

## The world

`scenarios/world.feature` at the root is the world: the company a demo opens on, written as one scenario of `Given` steps alone. It uses the same steps as any scenario, so it can describe a collection's records, the objects a vendor's fake holds and the calls a fake has had (`{op} was called with`). A [site demo](/sites/demos/) uses this starting state when it opens.

```gherkin
Feature: The company a demo opens on

  Scenario: Acme's books
    Given data.clients "acme" has
      | name | Acme Corp |
    And github.repository "website" has
      | has_wiki | true |
```

Sanoma validates the world separately and omits it from the list of runnable workflow scenarios. Its file holds exactly one `Scenario`. A `Scenario Outline`, a second scenario, a `When`, a `Then`, a fault, a decision or a step saying who is acting is refused at its line, and `sanoma check` reports that as it reports any feature file that does not load. Only the root has a world: a `world.feature` in an app's `apps/<app>/scenarios/` is an ordinary feature file, whose scenarios each need a `When`.

`loadWorld(scope)`, from `sanoma/workflows/scenario`, resolves to the world's `{ name, given }`, or `undefined` when the root has no `scenarios/world.feature`, and rejects with its error at its `file:line`. `loadScenarios` returns it too, as `world`, with its error among `errors`.
