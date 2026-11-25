---
title: Conformance suites
description: "Run the same connector scenarios against a fake and a driver, or check a host, database, wakeup service, or sandbox against its contract."
sidebar:
  order: 4
---

Use `describeFeatures(connector, { features, replay })` from `sanoma/testing/features` to check whether a connector’s fake and driver agree. It registers a Vitest `describe` for each target and a test for each Cucumber scenario. Each `When` calls the operation directly, without a worker or policy evaluation.

Feature files can use the [connector’s own steps](/testing/conformance/#steps-a-connector-ships) and the generic steps `{op} is called with`, `it returns`, and `it fails with status {int}`. The suite runs them on two targets.

- `fake` runs each scenario against a fresh connector fake.
- `driver` runs the same scenario against the driver with its usual `replay` options. Fixture names come from the lowercase scenario title with runs of other characters replaced by a dash. For example, `Publish draft` reads `publish-draft.json`. A missing fixture fails the test. Tag a scenario `@fake-only` to run it without a recording.

Set `SANOMA_LIVE=1` to send driver requests to the vendor. Also set `SANOMA_RECORD=1` to save the replies as fixtures. Cleanup runs after success or failure. For each resource `create` that returned an ID, the suite calls the type’s `delete` in reverse creation order. It uses the replacement ID after an `update` and skips resources the scenario already deleted. A cleanup failure fails the test and names the resource. Include the cleanup calls at the end of hand-written fixtures too.

Write assertions that work with either target’s IDs. Name the result of a `Given` with `as` and use a field such as `| id | $draft.id |` in the next table. Assert a shared outcome, such as `| status | published |` after `it returns`.

```ts
// connectors/ghost/test/features.test.ts
import { describeFeatures } from "sanoma/testing/features";
import { ghost } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

await describeFeatures(ghost, { features: new URL("../features/", import.meta.url), replay: replayOptions });
```

Status: early (0.x). License: FSL-1.1-ALv2.

## A host's conformance

Use `checkHost(host)` from `sanoma/testing/host` to check a declared [host](/hosting/hosts/) through callbacks and a `SanomaClient` connected to its database. The result lists `{ name, ok, error? }` for each check.

- The app answers `/healthz` at its `wakeUrl` or, if absent, its `url`. A queued run drains and the next trusted store read sees a credential change.
- A sleep survives a restart through the resource type’s `stop` and `apply` operations.
- Two concurrent deploys of a new commit leave the host on one revision. At least one must succeed. The other must finish or promptly report `superseded`.
- A new source commit shows up as drift in the host’s `revision`. Apply clears that drift.
- The ledger contains none of the host’s `secrets`.

The concurrent-deploy check exercises driver behavior only when apply calls the type’s operations directly, as the Cloudflare kit test does against its fake API. `throughWorkflows` serializes applies on the queue. `fakeHost` and the Sanoma Cloud fake also process one deploy at a time, so those results cannot establish a real platform’s concurrency behavior.

A host whose `capabilities.lifetime` is `stops-on-exit` also gives `suspend` (its runtime stopped as its platform may, its URL kept) and `running()` (whether its runtime runs now), has each start followed by a request to its `wakeUrl` (else its `url`, `/wake`), as the app's own writes are, and is checked for what one wake starts again: a run queued while it was stopped drains, and a sleep that ended while it was stopped continues; and for its end: it stops once its worker is idle, and a run queued while its worker stops (right after the worker records `sanoma_wakeup.stopped_at`) still runs.

The host's config registers `hostCheck` (a connector whose driver reads `HOST_CHECK_TOKEN`) and `hostCheckWorkflows`, which the checks start runs of.

```ts
const results = await checkHost({ type, apply, stop, client, secrets, commit, drift });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeHost(start)` is a host in this process (`testhost.app`, every change a replace, no secret in its state; a declared `hostname` is reported as its `url`, `https://<hostname>`, and not served: its `wakeUrl` is where it answers) and `inProcessHost(config, databaseUrl, options?)` a `start` for it, as `sanoma worker` runs the company: a worker under `superviseWorker` (given `options`, such as `idleHorizonMs` and `stopCheckMs`), which stops itself when idle with a wakeup, and a server that answers `/healthz`, and `GET /wake` with 204, recording each as the running host's `wakes` and handing it to the supervisor, which starts a fresh worker when its last one stopped.

When this process's environment names a host's wake route (`envWakeup`), the runtime ends once its worker stopped itself (`Running.exited`), its server closed first. `fakeHost(start, { lifetime: "stops-on-exit" })` is one that stops: its URL is a proxy on the declared port in front of the runtime, which ends with the runtime (`exited`) or on `stop()` while the proxy stays, and the next request starts it again, at the same revision with the same secrets, and is forwarded to it; its `type` reports the lifetime, `running()` whether a runtime runs behind it, and `wakes()` lists the wakes across its stops.

`testRepository()` is a bare git repository to be a host's source, with `commit()`.

## A wakeup's conformance

`sanoma/testing/wakeup` decides whether a wakeup (a resource type with a `wakeup`, see [Hosts](/hosting/hosts/)) wakes a stopped host when the runtime asked it to, and only then.

`checkWakeup(w)` registers wakes through `w.register` (the type's register operation, through its driver) and watches the `/wake` requests the host answers (`w.host.wakes()`), and returns each check as `{ name, ok, error? }`: a wake registered for 2 s from now arrives, not before its `at`; a wake registered before `w.host.stop()` starts the host again, and a run queued while it was stopped drains; a registration replaced before its `at` (2 s from now, by one 5 s from now) never wakes the host, the one that replaced it does; and a wake registered for a schedule's next fire, which falls while the host is stopped, runs that tick (it waits for the schedule's first tick while the host runs, since DBOS fires a missed tick from the last one fired, then for the next: up to twenty seconds).

The client's config registers `wakeupCheckWorkflows` (`hostCheckWorkflows` and `wakeup-check-tick`, every ten seconds), with its root's `package.json` naming an app of its own for each run, so no earlier run's schedule is fired over.

```ts
const results = await checkWakeup({ type, host: { url, stop, wakes }, client, register });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeWakeup()` is a wakeup in this process (`testwakeup.timer`, its `host` a reference to a `testhost.app` declaration by its `url`): its driver's `register` arms one timer for the one timer apply created, replacing any armed before, that sends `GET {host}/wake` at `at`, again every 250 ms until the host answers. `fire()` sends the armed wake now; `registered()` lists the registrations it took; `close()` disarms it.

Its tests run it over `fakeHost` with `stops-on-exit` and `inProcessHost`, and so does the stack test (`test/stack.test.ts`), with no account: the fake wakeup declared and applied for the host, a sleeping run and a schedule, the worker stopping itself and the process stopped in between, then woken.

## A database's conformance

`sanoma/testing/database` decides whether a database (a resource type with a `database`, see [Databases](/hosting/hosts/#databases)) holds the company as the runtime needs. `checkDatabase(db)` applies it (`db.apply()`, which must report it healthy), starts a worker on its URL (`db.url()`, the URL its `storeUrl` stores, read here for the test alone), and drives it through `db.client`, a `SanomaClient` on that URL, returning each check as `{ name, ok, error? }`: DBOS's tables migrate and the worker starts, the next trusted store read sees a credential change, and a queued run drains.

A database whose `capabilities.pauses` is true also gives `suspend` (its compute suspended, every connection dropped) and is checked for a run queued after it, which the client's query wakes the compute for and the reconnecting worker drains. The worker and the client both run `databaseCheckConfig(url)` (`hostCheck` and `hostCheckWorkflows`, no root), so the client's runs are of the worker's version; the kit stops its worker.

```ts
const client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
const results = await checkDatabase({ type, apply, url, suspend, client });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeDatabase(name?)` is a database of the test Postgres (`testdb.database` at `testDatabaseUrl(name)`, made by its `create` and dropped by its `delete`) that pauses: `suspend()` drops every connection to it, as a Neon compute's suspend does, and resolves to how many it dropped; `remove()` drops the database; its `storeUrl` stores the URL as `SANOMA_DATABASE_URL_<EXPORT>`. `connector` is for a config, `driver` for calling its operations directly.

## A sandbox's conformance

`sanoma/testing/sandbox` decides whether a sandbox backend (a connector's `sandbox` half, see [Sandboxes](/hosting/hosts/#sandboxes)) gives the boxes a coding agent needs. `checkSandbox({ backend, capabilities, image?, size?, name?, hosts? })` discards the box `name` (default `sanoma-kit`), opens it with `hosts` (what it may reach; default `registry.npmjs.org`), and drives it through the contract alone, returning each check as `{ name, ok, error? }`: the box opens, stdout arrives before a command exits, stdin reaches `cat`, a written file reads back and runs with its mode, the box opens again with other hosts (whether it reaches only its hosts needs a network, which the kit does not use), a command killed mid-run exits non-zero, and `discard` leaves the next `open` empty; with `capabilities.snapshot`, that file and one a command wrote under `$HOME` survive `stop` and the next `open`; with `capabilities.port`, a `node` server in the box answers at what `expose` returns.

Once no box opens, the rest fail at once. It discards the box at its end.

```ts
const results = await checkSandbox({ backend, capabilities: type.sandbox!.capabilities, image, size: 2 });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeSandbox(root?)` is `localBackend` (from `sanoma/workflows`) under a temporary `root`, with its type `testsandbox.box`: a box is the directory `<root>/<name>`, its home, its commands `bash -c` children in process groups of their own, its ports loopback's. `connector` is for a config, `backend` and `capabilities` for the kit; `remove()` deletes `root`.

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

A `given` returns a `Seed`: `{ op, input, as? }` calls the operation through the run's fake before it starts, `{ op, fault }` injects `failNext`, `rateLimit` or `loseReply` into its next call, and `{ resource, name, fields }` puts an object no operation makes in a sandbox run's fake, as `{resource} {string} has` puts one (`resource` is `<vendor>.<type>`, which need not be a resource type: GitHub's App installation, `github.installation`, which a person makes on GitHub's pages).

A `then` returns an `Expect`: `op` and `called` say what it is about (the graph marks the operation), and `check(run)` reads the run (`RunView`: its `records`; `calls(op)`, the calls made without an error; `seeded(op)`, what the `Given` steps seeded through it; and `made(op)`, both: each `{ input, output }`, typed by the operation) and returns why it does not hold, or throws; returning nothing passes. In `scenario.expect` such a step is `{ step, custom: true, op?, called? }`.

The same steps test the connector's own operations, in its `features/`: there the generic steps below call an operation directly (no worker, no policy) on a fake or on the driver over recorded replies, and `$name.field` in a table cell is a field of what a `Given` named `as` returned (`| id | $draft.id |`). A `Given` that calls a resource type's `create` seeds the object as apply makes it: the type's `afterCreate` calls follow, each polled as apply polls it (a Neon project's compute has started), the seed's name (else the type's) as the export a `storeUrl` stores under.

[`describeFeatures`](/testing/conformance/) runs them.

| Keyword | Step                                                              | What it does                                                                                     |
| ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When    | `{op} is called with` and a JSON doc string or a two-column table | Calls the operation with that input, the rest made up; the call and its output or error are kept |
| Then    | `it returns` and a two-column table of fields of its output       | Expects the last call to have returned at least these fields, at any depth                       |
| Then    | `it fails with status {int}`                                      | Expects the last call to have failed with that vendor status                                     |

A workflow's scenario refuses `{op} is called with`, and an operation's own test refuses a step that runs a workflow, decides an approval or seeds a resource; a fault needs the fake.
