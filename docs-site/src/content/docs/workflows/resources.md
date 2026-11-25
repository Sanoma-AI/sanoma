---
title: Resources and data files
description: "Declare vendor resources in company files, compare them with live state, and apply reviewed changes."
sidebar:
  order: 8
---

A resource declaration describes the state the company wants at a vendor. For a GitHub repository, for example, the declaration names the repository and the fields the company manages. [Drift](#drift) reports differences from live state. [Apply](#apply) plans and makes changes.

To manage a vendor object, start with its declaration in the company repository. For a connector that introduces a new type of object, see the [resource type reference](/reference/resource-types/).

## Data files

A company declares the resources it wants in TypeScript data files under `resources/` beside its config, `resources/<area>/<file>.ts`, as its workflows are in `workflows/`. Sanoma loads each one, as Node imports a module, and reads what it exports:

```ts
// resources/identity/github.ts
import { github } from "@sanoma-ai/connector-github/resources";

export const website = github.repository({ owner: "acme", name: "website", visibility: "public", has_wiki: false });

export const websiteMain = github.branch_protection({
  repository_id: website, // a reference: stands for the repository's identity, "acme/website"
  pattern: "main",
  enforce_admins: true,
});

export default [website, websiteMain];
```

Another data file names `website` by importing it: `import { website } from "./github.ts"`.

### Loading and reloading files

A data file is TypeScript like any other: it may compute a value, spread a shared object or import a helper of its own. Each exported value that a resource type's constructor made (`<vendor>.<type>({ … })`, the vendor's constructors imported from its connector's `<info.package>/resources` entry, the people's from `sanoma/resources`) is one declaration, `<file>#<export>`, in the file that made it (another file re-exporting it declares nothing), under its non-default name when the file also exports it as `default`; anything else the file exports, such as the list `export default [a, b]` that Sanoma writes, declares nothing.

A field the type's `fields.references` allows a resource in is given the declared value itself, and names the declaration that exports that very object. A field the type's `fields.writeOnly` lists takes `secret("NAME")` or `secret("NAME", { generate: true })`, imported from `sanoma/resources` (see [Secrets](/hosting/secrets/#secrets)). `resources/data.ts` is the exception: it holds the [collections](/workflows/collections/) and nothing else.

The loader (`loadModules`) loads synchronously, since `describeConfig` and `readPeople` are: `require` of an ES module, Node's type stripping and `module.registerHooks`, so a data file may not use top-level `await`.

It serves the modules a company file imports from the runtime itself, from its own objects: each connector's `<package>/resources` with the config's constructors, `sanoma/resources`, `sanoma/data` (`collection`), `sanoma/site` (`defineSite`) and, to an app's `app.ts`, `sanoma` (`defineApp`); so a data file never needs the package installed, and each value they make records where it was made.

Each load is a generation: a file is loaded again, with what it imports, once it, a company file it imports or a directory they are in has changed (by size and modification time), so an edit is read without a restart; every other call answers from the generation, at the cost of a `stat` per file.

`liveDescription(config)` (`sanoma/workflows/describe`) keeps a `describeConfig` and makes it again only once a file a load read (`stampsOf`), the lockfile, or a folder a new data file, app or site would appear in has changed: the app reads its description through it, so a saved field shows on the next page without a restart. A superseded generation's modules stay in Node's cache, a copy of the files per edit.

The data files are found from the config's root: `defineConfig` records the file it is called from as the config's `file`, and `resolveConfig` gives its directory as `root`. A config bundled into one file sets `root` itself. A config with neither has no data files, and says so, rather than guess the working directory.

`loadDataFiles(root, connectors)`, from `sanoma/workflows/describe`, loads every regular `.ts` file under `<root>/resources` and each app's `apps/<app>/resources` (but `*.test.ts`, `*.d.ts` and `node_modules`). It returns `{ resources, bindings, orphans, collections, problems }` (`collections`: where each `resources/data.ts` declares each collection, `{ id, file, name, at }`, never matched to a connector, a type or the lockfile): one `DeclaredResource` per declaration, by file and then in the order made, less any with a problem and any that names one, and the problems.

Their shapes are the zod schemas `DeclaredResourceSchema` and `ResourceProblemSchema` in `sanoma/workflows/description`:

```jsonc
// A DeclaredResource
{
  "id": "resources/identity/github.ts#websiteMain", // <file>#<export>, the file relative to the root
  "file": "resources/identity/github.ts",
  "vendor": "github",
  "type": "branch_protection",
  "name": "acme/website:main", // what people call it: its identity, else its export's name
  "identity": "acme/website:main", // the import id that finds it unbound, from `find`
  "binding": "BPR_kwDOabc123", // the id of the object the lockfile binds it to
  "at": { "file": "resources/identity/github.ts", "export": "websiteMain" },
  "desired": { "repository_id": "acme/website", "pattern": "main", "enforce_admins": true }, // as its type checked them
  "refs": { "repository_id": "resources/identity/github.ts#website" }, // where it names a resource, that resource's id
}
// A ResourceProblem, had `website` been written with `wiki: false`: at the line and column an error's stack gives, else at its export, else at its file
{ "file": "resources/identity/github.ts", "line": 4, "column": 31, "message": "github.repository: no field wiki" }
```

### Declaration errors

A problem is, at the line and column the error's stack gives: a file that throws as it loads, a value its type refuses (a resource where it takes none among them) or a type its vendor does not declare, and a syntax error. V8 places a call at its method's name, so the column above is at `repository`. A file stops at its first, so a broken file is one problem, and a file whose import threw is reported once, at the file that threw.

At the file: an import Node cannot find (a constructors import of no connector in the config, a file that is not there), top-level `await`, and a resource made but never exported (written inline in a list, say).

At `file#export`: one object exported under two names, a reference to a resource no data file exports, a type of no connector in the config, a resource declared in `resources/data.ts` or a collection in another data file, two resources of one type with one identity (and connection), and, from the lockfile ([below](#bindings)), a binding of another type than its declaration's or two declarations bound to one object; a lockfile that is not JSON or not bindings is the lockfile's.

`describeConfig` lists them, as `resources` and `problems` (and the lockfile's `orphans`), so the app starts with the resources it could read and shows what is wrong in the rest; `sanoma check` prints them. No lint holds a data file to a form: what loads is read. `readResources(config)` is the strict reading, for a test or CI: it returns the resources, or throws one error listing every problem as `problemLine` prints it (`file:line:column`, `file#export` or `file`).

### Bindings

Which vendor object a declaration means lives in a lockfile beside the data files, `resources/sanoma.lock.json` (`LOCKFILE`), not in the declaration, as `package-lock.json` is beside `package.json`: data files hold intent only, so an edit to a field cannot point a declaration at another object, copying a declaration copies no binding, and a rename is an update. Only apply writes it; it is committed.

```jsonc
{
  "resources/identity/github.ts#website": { "type": "github.repository", "id": "R_kgDOabc123" },
  "resources/billing/stripe.ts#pro": { "type": "stripe.product", "id": "prod_Rx2" },
}
```

`loadDataFiles` joins each declaration to its binding by its key, `<file>#<export>`, as `binding`, returns the lockfile's `bindings`, and lists as `orphans` (`{ key, type, id }`) the bindings no data file declares, but those of a file that failed to load, whose declarations are not known. A missing lockfile binds nothing.

`sanoma/workflows/describe` exports `readLockfile(root)` (`{ bindings, problems }`), `serializeLockfile(bindings)` (keys sorted, two-space JSON, a trailing newline), `writeLockfile(root, bindings)` (whole or not at all: written beside it, then renamed), and `diffLockfiles(before, after)`, each change a `Rebind`: `{ key, type, kind: "bind" | "rebind" | "unbind", from?, to? }`.

### Writing a data file

Sanoma writes company files too, from `sanoma/workflows/describe`, by parsing them (with oxc-parser), not loading them: a written file must keep every byte it does not change. `setFields(text, exportName, fields, options)` returns the file's text with fields of one declaration set, by dotted path as a drift report names them (`{ has_wiki: true, "metadata.owner": "ops" }`; a field the declaration lacks is added).

The declaration is the object literal of `export const <exportName> = …`, or of `export default …` for `"default"`: the object itself, or the first argument of the call it is (`github.repository({ … })`, `collection({ … })`, `defineSite({ … })`, `defineApp({ … })`).

Only that statement changes, formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter), and every other byte of the file stays as it was. It writes literals only: a value the file computes (a name, a reference to another resource among them; a call but `secret(…)`; a spread; a template with `${}`), a path into an object or list that holds a spread, and a declaration that is no object literal throw `NotLiteral`, whose `reason` says what to edit in code instead (`the value of has_wiki is computed in the file`) and whose `field` names the field the file computes (none for a declaration that is no object literal).

It refuses with a plain `Error` a file that does not parse, an export the file does not have, and a path through a value that is not an object or a list; a path whose segments name a field with a dot in its key (`metadata: { "app.owner": … }`) finds that field.

`renderDataFile({ imports, exports }, options)` renders a whole new file, which, loaded, declares what it was given; a reference is a `Reference`, and a secret's marker is written as `secret("NAME")` (or with `{ generate: true }`), the file then importing `secret` from `"sanoma/resources"` (`setFields` adds that import after the file's own when it sets one). `formatOptions(root)` reads the options from `<root>/.oxfmtrc.json`, oxfmt's defaults without one.

oxfmt is a dependency of this package, loaded only when a file is written. The app's Adopt and its forms' Save write through it ([the app's Hosting page](/start/the-app/)).

### Where Sanoma parses instead

Everything a company file declares is read by loading it, but for these, which parse source with oxc and never run it: the workflow [outline](/workflows/your-own-ui/#outline) and the workflow lint ([Keeping workflows replay-safe](/workflows/replay-safety/)), since a run is held to its code's shape, not to what it did once; a site's pages and what they call (`readSites`: a site's files are browser JSX, read as the site's outline), though its `site.ts` is loaded; `crossAppImports`, a lint over imports; a draft's files, never loaded, since a draft is someone's unreviewed code: a change's facts are told from their text (`mayDeclarePeople`, `isRules`), and updating an app reads `main`'s `app.ts`, never the draft's; `sanoma`'s template, inside the installed package under `node_modules` where Node strips no types, whose people's ids `sanoma` reads from its text when it starts a company; and the writer above.

## Drift

Start `drift` with `{}` to compare declared resources with the vendor’s current state. `resolveConfig` adds this workflow when the config’s connectors declare resource types. `describeConfig` marks it `builtin: true`. Its name is reserved.

Drift lists each supported resource type’s `import` operation in `uses`. Its version therefore tracks connector and driver changes independently of data-file edits. Like a company workflow, drift passes its vendor calls through `ctx` and follows the workflow lint rules. The policy evaluates each call as a read and the ledger records it.

```ts
const runId = await client.drift({ startedBy: { id: "alice" } }); // start(drift, {}, …)
const report = await client.driftReport(runId); // waits for it, as `result` does
// { startedAt, finishedAt, problems: [], resources: [{ id, type, vendor, name, binding, status: "drifted", fields: [{ path: "has_wiki", desired: false, actual: true }] }, …] }
```

The run reads the data files and the lockfile itself, in its first step (`drift:data-files`, recorded, so a replay checks the same list): its input is `{}`, and any other is refused, so no caller can hand it other resources. The step records each resource without its write-only values, and the files' problems, which the report carries (`problems`; a file with problems contributes no resources, as in `describeConfig`). The worker loads the reader only then.

Then the run imports each resource by its binding, else by its identity, one vendor call each (none for a resource with neither), in the files' order (every run imports: no state is kept between runs yet), and compares the declared fields with `diffDeclared` (above), a reference against the state of the resource it names from the same run.

Each resource's `status` is `clean`, `drifted` (with `fields`, each leaf that differs: `{ path, desired, actual }`, a list item's path with its index, a list whose length changed or an `unordered` one whole), `gone` (the import of its binding says so), `absent` (it is not bound; `found` is the binding id of the object its identity found, if any, which apply may bind it to) or `error` (with `error`: the vendor's error, a policy denial, or no driver for its type); one resource's failure does not stop the others, but a failure that ends the run (`isRunControlError`: DBOS cancelling or stopping it) does.

`client.drift` throws `invalid_input` when the connectors declare no resource types; `client.driftReport(runId)` throws `invalid_input` for another workflow's run. `DriftReport`, `DriftResult`, `DriftField` and `DriftStatus` are the report's types, also in `sanoma/workflows/shared`; `client.runs({ workflow: "drift" })` lists drift runs.

A host's revision is drift too (see [Hosts](/hosting/hosts/)): the run resolves its ref with the built-in `sanoma.source.resolve`, and a host whose state runs another commit is `drifted`, with a field at its `revision` path (`desired` the commit the ref names now). A bound host's row also carries where its state says it answers (`host`: its `url`, `wakeUrl` and `healthy`, as the host's `outputs` read them), which the app's Hosting reads.

## Apply

The built-in `apply` workflow makes vendor resources match their declarations. Like `drift`, it appears as `builtin: true`. It uses `import` for each type with a driver, the change operations of each writable type, and `approval`. Only `apply` can call a declared resource’s change operations. Its input is `{ only?, bind?, answers? }`.

| Optional input | Meaning                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `only`         | Plan the listed declared IDs (`<file>#<export>`) or orphaned lockfile keys. Omit to plan all resources.                                              |
| `bind`         | Map a declared ID to the ID of the existing vendor object it should manage.                                                                          |
| `answers`      | For a missing vendor object, choose `recreate` or `forget`. For an orphaned binding, choose `forget` or `delete`. Key answers by ID or lockfile key. |

Sanoma refuses other input fields.

```ts
const runId = await client.apply(
  { answers: { "resources/infra.ts#store": "recreate" } },
  { startedBy: { id: "alice" } },
);
const report = await client.applyReport(runId); // { plan: { problems, rebinds, steps }, results, lockfile: { written, revision?, bindings } }
```

### Planning and approval

The run reads the data files and the lockfile in its first step (`apply:data-files`; a secret's marker stays in `desired`, a plain write-only value does not), with the lockfile's `rebinds`: what changed in it since apply last wrote it (`diffLockfiles` against the bindings the latest live apply run's last `apply:lockfile` step wrote), changes someone else made.

It imports each declared resource as drift does (by the binding `bind` gives, else the lockfile's, else its identity), then plans each one `only` wants, each after the resources it names, as a `PlanStep` (`{ id, vendor, type, action, … }`): `bind` (to the object `bind` gives, or the one its identity `found`, by its binding id), `create` (unbound and nothing found: `planned` and `unknown` from its type's `plan`), `update` or `replace` (its bound object as `plan` says, with drift's `fields`, the paths that force a replace, and any `unknown` until it is done), `none`, `gone` (its bound object is no longer there: skipped unless answered, since a recreated database looks fine and has lost its data; a type with `stateless: true`, holding no data, is planned as a `create` instead, unless answered), and `orphan` for each binding no declaration has (skipped unless answered: deleting a declaration never deletes its object).

What cannot be planned (a read-only type that is absent or drifted, an answer that cannot be done, an id the input names that nothing declares) is one of the plan's `problems`, with no step.

When the policy would hold any change call the plan makes (asked ahead, in the step `apply:policy`, as each call would ask it), the run asks one approval of the first approver it names, titled "Apply resource changes", covering every change operation in the plan, with the plan as JSON in its `details`; a policy that lets a covered call through once approved (`approvedFor`) then holds none of them again.

Then each step runs, in order: `create`, `update` (with `expect`, the plan's action and replace, so a vendor that now plans otherwise refuses with `plan_changed`), `delete`, or only the lockfile changed. A reference to a resource the vendor holds by another field (`by`) is given that resource's binding id, one made earlier in the run included, and a `from` reference that resource's state at its path, as found or as an earlier step left it (see [Resources](/workflows/resources/)).

### Recording bindings and queuing runs

Right after any step that changes a binding, that binding is changed on the lockfile as it is then (so another run's change made meanwhile stays), written whole and committed through the worker's `source` (`apply:lockfile`: `Apply: create resources/infra.ts#store (supabase.project abcd…)`, by the person who started the run), so an object made is never left unbound.

Right after a create's binding is written, the run calls its type's `afterCreate` operations in order, by id, each given the new object's binding id and its export (a Supabase project waits for its health, then stores its database URL); one with `until` is called again every 5 seconds until its output passes, for up to 10 minutes, and one that never does fails the step, its object still bound. The approval covers the `write` ones among them too.

Each step's result is `done`, `skipped` (unanswered) or `failed` (with `error`; the run goes on); a host's that it made or changed carries `host`, its `outputs`. A sandbox run writes nothing: the report's `lockfile.bindings` is its copy. `ApplyPlan`, `PlanStep`, `ApplyReport` and `ApplyResult` are the types, also in `sanoma/workflows/describe` and `/shared`.

One live apply runs at a time for each app on a database. Every apply that is not a sandbox run runs on the apply queue, `sanoma:<appName>:apply`, which DBOS limits to one running run, counted in Postgres over every process and version of the app. This covers an apply started from the app (`client.apply`), a change's deploy, a push to `main` and going live. A second apply waits as `queued` until the first ends, then plans the data files as they are by then.

`client.applyAhead(runId)` names the apply it waits for: the one running or waiting for an approval, else the oldest queued before it. The app shows that apply on the queued run's page and on Hosting. A sandbox apply calls fakes, so it runs on the app's queue and never waits. An apply waiting at its plan's approval keeps its place, so the plan stays true while someone reads it, and the ones behind it do not keep the worker up (`idle`).

One held at its start (an agent's waits for `admin`, or a company `@hold` on `workflow:apply`) waits on the app's queue instead and keeps no place: once approved, it starts the apply as its child, `<runId>:apply`, on the apply queue, which then waits its turn, and the held run ends with the child's report as its output.

The limit assumes one live worker per database, as a deploy runs: a worker that starts as the latest version takes over or cancels the unfinished applies of other versions ([Versions](/hosting/versions/)), so an older worker still running one of them then can overlap the next apply.

`plan` is the built-in workflow that says what an apply would do and changes nothing: it takes apply's input, plans with the same code, and returns the `ApplyPlan` an apply with that input would make, calling only the `import` and `plan` operations and `sanoma.source.resolve`, with no approval and no write to a vendor, the lockfile or the secret store.

It reads the data files as drift does (`plan:data-files`), so before the first apply of a host that clones a private repository, the plan has no step for the deploy key apply makes for it, and an `only` or `answers` that names that key (`<file>#<host>.sourceKey`) is an unknown id to the plan, though not to the apply; and it never waits on the apply queue.

This package knows nothing of OpenTofu. Resource types from an OpenTofu provider are generated by [`sanoma/internal/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/bridge/src/tfschema/AGENTS.md), which turns the provider's schema document into zod schemas and flagged fields (`resources.gen.ts`); `sanoma/internal/bridge` depends on this package, never the other way round.

## Connector resource types

- <a id="resource-operations" href="/reference/resource-types/#resource-operations">Operations derived from a resource type</a>
- <a id="declaring-and-referencing-objects" href="/reference/resource-types/#declaring-and-referencing-objects">Declaration and reference types</a>
- <a id="dependencies-during-an-apply" href="/reference/resource-types/#dependencies-during-an-apply">Dependencies during an apply</a>
- <a id="comparing-declared-fields" href="/reference/resource-types/#comparing-declared-fields">Field comparison rules</a>
