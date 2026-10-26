# @sanoma-ai/testing

Helpers for testing [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows) workflows without vendor accounts.

## Install

Private to this repository: its tests import it through the workspace, and it is not published.

## A worker for a test

`startTestWorker(config, { databaseUrl, ...options })` calls `startWorker` with test defaults: the database `databaseUrl`, which is required, and, unless the config has one, a fresh in-memory ledger. `testWorkerConfig(config, databaseUrl)` is that config, for a worker started another way (`inProcessHost` supervises one). Tests are kept apart by database, not by app name: give each test file (or each `describe` that starts a worker) a database of its own, `testDatabaseUrl("announce")`, since two sharing one would recover each other's runs; the app keeps its name, its root's `package.json`'s. A `databaseUrl` in the config is ignored, so a test can spread the project's own config without reaching its real database. The other options (`promote`, `logLevel`) go to `startWorker`.

`testDatabaseUrl(suffix)` is `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the database name. Give each test file its own suffix, so files don't recover each other's runs. DBOS creates the database if it is missing.

`withFake(connector, fake)`, re-exported from `@sanoma-ai/workflows/fake`, is the connector set up with that fake instead of the one its package attaches, so live runs call it, and sandbox runs too, since its maker gives this very one: what a test that seeds or reads a fake passes in `connectors`. Swapping the driver alone, `withSetup(connector, { driver: () => fake.driver })`, keeps the package's maker, so each sandbox run has a fake of its own.

`ensureBuilt(pkgDir, outputs, build)` runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` is missing or older than a file under its `src/`, for tests of what a package ships from `dist/`. `waitFor(get, done?, timeoutMs?)` calls `get` every 100 ms until `done` holds for its value (by default, until it is truthy), returns that value, and throws after `timeoutMs` (default 15 seconds) naming the last one.

```ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { type FakeCall, startTestWorker, testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import announce from "./workflows/announce.ts";

const calls: FakeCall[] = [];
const blog = fakeGhost({ calls });
const email = fakeResend({ calls });
const worker = await startTestWorker(
  { workflows: [announce], connectors: [withFake(ghost, blog), withFake(resend, email)] },
  { databaseUrl: testDatabaseUrl("announce") }, // the database this file's tests run on
);

// ...start a run and wait for it to finish, then:
calls.map((c) => c.op); // ["ghost.post.create", "resend.broadcast.create", ...]
Object.values(email.state.broadcasts).map((b) => b.status); // ["sent"]
await worker.stop();
```

## A test app

`@sanoma-ai/testing/harness` starts a worker and its clients for the tests of a `describe` (or a file), and stops them after (install `vitest` and `@dbos-inc/dbos-sdk` beside it). `useTestApp(config, { databaseUrl, ...options })` takes `startTestWorker`'s arguments and returns a `TestApp`:

| Member      | What it is                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`    | The config the worker and the clients share: yours, with `ledger` (default `memoryLedger()`) and `databaseUrl` (the option's) filled in once.                                        |
| `client`    | A `SanomaClient` of the worker: start runs, decide approvals, read the ledger.                                                                                                       |
| `raw`       | A `DBOSClient` of the same app, which sends messages and reads a run's steps without `SanomaClient`'s checks.                                                                        |
| `stop()`    | Stops the worker, as a process that stopped would.                                                                                                                                   |
| `restart()` | Stops the worker (unless `stop` did) and starts another on the same config and ledger, as a restarted process would: the runs it had in progress resume, and their records are kept. |

`client` and `raw` throw "is not started" outside the tests. Fakes a test reads are yours: create them beside the call, pass them with `withFake`, and reset them in your own `beforeEach`.

```ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { testDatabaseUrl, withFake } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { beforeEach, expect, it } from "vitest";
import publish from "./workflows/publish.ts";

const blog = fakeGhost();
const app = useTestApp(
  { workflows: [publish], connectors: [withFake(ghost, blog)] },
  { databaseUrl: testDatabaseUrl("publish") },
);
beforeEach(() => blog.reset());

it("publishes, across a restart", async () => {
  const runId = await app.client.start(publish, { title: "Launch" }, { startedBy: { id: "alice" } });
  await app.restart();
  await app.client.result(runId);
  expect(Object.values(blog.state.posts).map((p) => p.status)).toEqual(["published"]);
});
```

A memory ledger lives in the test process, so it outlives a restart there. To keep the records on disk, pass `ledger: jsonlLedger(dir)` yourself.

## Fake vendors

Each connector carries its fake, and ships it at its own `/fake` entry, not in this package: `import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";`. Install the connectors you use; their READMEs ([Ghost](https://www.npmjs.com/package/@sanoma-ai/connector-ghost#testing), [Resend](https://www.npmjs.com/package/@sanoma-ai/connector-resend#testing), [Bluesky](https://www.npmjs.com/package/@sanoma-ai/connector-bluesky#testing), [GitHub](https://www.npmjs.com/package/@sanoma-ai/connector-github#testing), [Stripe](https://www.npmjs.com/package/@sanoma-ai/connector-stripe#testing)) say what each fake holds and adds. Each returns:

| Member                 | What it does                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `driver`               | Its driver: what live runs call when the connector is set up with the fake (`withFake`).       |
| `state`                | The vendor's state, such as `posts` or `broadcasts`.                                           |
| `calls`                | Every call received, in order, with its input and idempotency key.                             |
| `reset()`              | Empties the state, the remembered replies and the pending faults.                              |
| `update(change)`       | Changes the state as someone at the vendor would, for the next call to see.                    |
| `failNext(opId, err?)` | The next call to `opId` throws `err` (default: a retryable `DriverError`) and changes nothing. |
| `loseReply(opId)`      | The next call to `opId` takes effect, then throws once, as if the reply was lost.              |
| `rateLimit(opId)`      | The next call to `opId` throws a retryable `DriverError` with status 429 and changes nothing.  |
| `hold(opId)`           | The next call to `opId` waits, before it takes effect, until the returned function is called.  |

A call that repeats an earlier call's idempotency key gets the earlier reply and changes nothing, so a test can check that a retried or replayed call has one effect.

Options: `{ calls }` logs into the array you pass, so several fakes share one ordered log.

To write a fake for another connector, use `defineFake(connector, { initial, ops })` from `@sanoma-ai/workflows/fake`. `ops` gets the state and implements every operation, typed by the connector.

`fakeMarketingVendors` is gone: compose the fakes you need, passing them one `calls` array, as in the example above.

## Replaying a vendor's API

`@sanoma-ai/testing/replay` tests a driver against a vendor's recorded replies, with [msw](https://mswjs.io) (install `msw` and `vitest` beside it). Call `replay(options)` once at the top of a test file: it starts msw for the file and returns `play`, `fixture`, `sent`, `exchanges` and the msw `server`.

```ts
import { replay } from "@sanoma-ai/testing/replay";

const { play, sent } = replay({
  fixtures: new URL("./fixtures/", import.meta.url),
  needs: ["ACME_API_KEY"], // live, the run fails at once without these
  env: { ACME_API_KEY: "test-key" }, // replaying, each test starts with these
  scrub: (exchanges) => exchanges, // what of a recording the repo may hold
});

it("creates a widget", async () => {
  play("create"); // fixtures/create.json
  await acmeDriver().ops["widget.create"]!({ name: "x" }, call);
  expect(sent[0]?.body).toEqual({ name: "x" });
});
```

A fixture, `<name>.json`, is a list of exchanges: `{ method, path, status, headers?, body }`, where `path` is the URL's decoded path and query (the host is not compared) and `headers` keeps only rate-limit headers. `play(name)` answers the test's requests with them, in order; a request that is not next in the fixture, or an exchange no request asked for, fails the test. `play(name, exchanges)` serves a list the test builds instead, for the cases a vendor will not reproduce on cue. `fill(exchange, sent)`, an option, fills a fixture's placeholders from the request it answers, such as an id the request chose. `sent` holds the requests the test made, bodies parsed; `exchanges` the replies they got.

Two variables change what the same tests do:

- `SANOMA_LIVE=1` calls the vendor instead: every request goes through to it. A run without the `needs` variables fails at once rather than replaying. Tests that only replay skip themselves with `it.skipIf(live)`.
- `SANOMA_RECORD=1`, with `SANOMA_LIVE=1`, rewrites each played fixture from the vendor's replies, passed through `scrub` first. Read the diff, and run `pnpm format`, before committing it.

## Scenarios

`@sanoma-ai/testing/scenarios` runs a config's [scenarios](https://www.npmjs.com/package/@sanoma-ai/workflows#scenarios-and-sandbox-runs) as vitest tests (install `vitest` and `@dbos-inc/dbos-sdk` beside it). Each scenario is a sandbox run: the worker calls fakes of its own, made by the makers the connectors carry, never a driver.

`describeScenarios(config, options)` compiles the `.feature` files in `scenarios/` in the config's root with Cucumber, so a test file awaits it at its top level, and registers a test for each scenario, in a `describe` per file, each over `runScenario` from `@sanoma-ai/workflows/scenarios` (the one implementation; `runScenarios` there, which `sanoma check` runs, needs no vitest); it throws, naming the root or the directory, when the root has no `scenarios/` or it holds no scenarios. A test starts the scenario's sandbox run, decides its approvals as the scenario says, and fails listing each `Then` step that did not hold, with why (each judged on its own). A file that does not load (a step no rule matches, bad JSON, a name used twice) is a failing test named after the file, whose message names the file (and the line, for a step or JSON error). It starts one [test app](#a-test-app) for all its scenarios, before them, with `useTestApp(config, options)`, and stops it after, on `options.databaseUrl`, as for `startTestWorker`. `options.startedBy`, an id (`"ada"`) or a principal, starts the runs whose scenario does not say who `is acting` (default `scenarios`), and `options.timeoutMs` is how long each may take (`drive`'s, 15 seconds by default); the tests it registers get twice that, so `drive`'s error is the one you see.

```ts
// test/scenarios.test.ts
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { describeScenarios } from "@sanoma-ai/testing/scenarios";
import { memoryLedger } from "@sanoma-ai/workflows";
import config from "../sanoma.config.ts";

await describeScenarios({ ...config, ledger: memoryLedger() }, { databaseUrl: testDatabaseUrl("scenarios") });
```

A company config spread into `describeScenarios` keeps its `ledger`, so pass `ledger: memoryLedger()`, as above, to keep test runs out of the project's ledger.

Besides a run's calls and outcome, a scenario can say what the policy did and, with the vendors' fakes holding what the data files declare, what the built-in [drift](https://www.npmjs.com/package/@sanoma-ai/workflows#drift) check finds (the full list of steps is in the workflows package):

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

`runScenario(scenario, { client, scope, startedBy?, timeoutMs? })`, re-exported from `@sanoma-ai/workflows/scenarios`, runs one scenario against a worker you started, with a `SanomaClient` of it, and returns `{ runId, run, ledger, checks }`: the run's id, its summary, its ledger records and `check(scope, scenario, ledger)`. `timeoutMs` goes to `drive`. Load the scenarios with `await loadScenarios(scope)` from `@sanoma-ai/workflows/scenario`, `scope` being `resolveConfig(config)`.

## A connector's own features

`@sanoma-ai/testing/features` runs a connector's own feature files, which test its operations with its [steps](https://www.npmjs.com/package/@sanoma-ai/workflows#steps-a-connector-ships) and the generic ones (`{op} is called with`, `it returns`, `it fails with status {int}`), as vitest tests. `describeFeatures(connector, { features, replay })` registers a `describe` per target and a test per scenario in each, in Cucumber, its `When` steps calling the operation directly (no worker, no policy):

- `fake`: a new fake of the connector's for each scenario.
- `driver`: the connector's driver over its vendor's recorded replies, with `replay`'s options (the driver tests' own, so both replay alike). Each scenario plays the fixture named after it, its name in lower case with each run of other characters a `-` (`Publish draft` plays `publish-draft.json`); one with no recording is tagged `@fake-only`, and runs on the fake alone. A missing fixture fails the test, saying so. With `SANOMA_LIVE=1` the driver calls the vendor, as the driver tests do, and with `SANOMA_RECORD=1` too, each scenario's replies are saved as its fixture; what a live scenario creates stays on the account.

A scenario's checks must hold on both targets, whose ids differ: name what a `Given` returned (`as`) and use its fields in a later table (`| id | $draft.id |`), and check fields both return (`it returns` then `| status | published |`), not ids.

```ts
// connectors/ghost/test/features.test.ts
import { describeFeatures } from "@sanoma-ai/testing/features";
import { ghost } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

await describeFeatures(ghost, { features: new URL("../features/", import.meta.url), replay: replayOptions });
```

Status: early (0.x). License: FSL-1.1-ALv2.

## A host's conformance

`@sanoma-ai/testing/host` decides whether a host (a resource type with a `host`, see [Hosts](../workflows/README.md#hosts)) runs the company as the runtime needs. `checkHost(host)` drives one declared host through callbacks and a `SanomaClient` on its database, and returns each check as `{ name, ok, error? }`: the app answers `/healthz` at its `url`, a queued run drains, `LISTEN` hears a credential change, a sleep survives a restart (`stop`, then `apply`, through the type's own operations), a new commit on the source shows as drift at the host's `revision` that `apply` clears, and none of the host's `secrets` is in any ledger record. A host whose `capabilities.lifetime` is not `long-lived` also gives `suspend` (its runtime stopped as the host stops it, its URL kept), and is checked for what one request to its URL (`/wake`) starts again: a run queued while it was stopped drains, and a sleep that ended while it was stopped continues. The host's config registers `hostCheck` (a connector whose driver reads `HOST_CHECK_TOKEN`) and `hostCheckWorkflows`, which the checks start runs of.

```ts
const results = await checkHost({ type, apply, stop, client, secrets, commit, drift });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeHost(start)` is a host in this process (`testhost.app`, every change a replace, no secret in its state) and `inProcessHost(config, databaseUrl, options?)` a `start` for it, as `sanoma serve` runs the company: a worker under `superviseWorker` (given `options`, such as `idleHorizonMs` and `stopCheckMs`), which stops itself when idle with a wakeup declared, and a server that answers `/healthz`, and `GET /wake` with 204, recording each as the running host's `wakes` and handing it to the supervisor, which starts a fresh worker when its last one stopped. `fakeHost(start, { lifetime: "stops-when-quiet", quietAfterMs? })` is one that stops: its URL is a proxy on the declared port in front of the runtime, `stop()` (and, quiet that long, `quietAfterMs`) stops the runtime while the proxy stays, and the next request starts it again, at the same revision with the same secrets, and is forwarded to it; its `type` reports the lifetime, and `wakes()` lists the wakes across its stops. `testRepository()` is a bare git repository to be a host's source, with `commit()`.

## A wakeup's conformance

`@sanoma-ai/testing/wakeup` decides whether a wakeup (a resource type with a `wakeup`, see [Hosts](../workflows/README.md#hosts)) wakes a stopped host when the runtime asked it to, and only then. `checkWakeup(w)` registers wakes through `w.register` (the type's register operation, through its driver) and watches the `/wake` requests the host answers (`w.host.wakes()`), and returns each check as `{ name, ok, error? }`: a wake registered for 2 s from now arrives, not before its `at`; a wake registered before `w.host.stop()` starts the host again, and a run queued while it was stopped drains; a registration replaced before its `at` (2 s from now, by one 5 s from now) never wakes the host, the one that replaced it does; and a wake registered for a schedule's next fire, which falls while the host is stopped, runs that tick (it waits for the schedule's first tick while the host runs, since DBOS fires a missed tick from the last one fired, then for the next: up to two minutes). The client's config registers `wakeupCheckWorkflows` (`hostCheckWorkflows` and `wakeup-check-tick`, every minute), with its root's `package.json` naming an app of its own for each run, so no earlier run's schedule is fired over.

```ts
const results = await checkWakeup({ type, host: { url, stop, wakes }, client, register });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeWakeup()` is a wakeup in this process (`testwakeup.timer`, its `host` a reference to a `testhost.app` declaration by its `url`): its driver's `register` arms one timer for the one timer apply created, replacing any armed before, that sends `GET {host}/wake` at `at`, again every 250 ms until the host answers. `fire()` sends the armed wake now; `registered()` lists the registrations it took; `close()` disarms it. Its tests run it over `fakeHost` with `stops-when-quiet` and `inProcessHost`, and so does the stack test (`test/stack.test.ts`), with no account: the fake wakeup declared and applied for the host, a sleeping run and a schedule, the worker stopping itself and the process stopped in between, then woken.

## A database's conformance

`@sanoma-ai/testing/database` decides whether a database (a resource type with a `database`, see [Databases](../workflows/README.md#databases)) holds the company as the runtime needs. `checkDatabase(db)` applies it (`db.apply()`, which must report it healthy), starts a worker on its URL (`db.url()`, the URL its `storeUrl` stores, read here for the test alone), and drives it through `db.client`, a `SanomaClient` on that URL, returning each check as `{ name, ok, error? }`: DBOS's tables migrate and the worker starts, `LISTEN` hears a credential change, and a queued run drains. A database whose `capabilities.pauses` is true also gives `suspend` (its compute suspended, every connection dropped) and is checked for a run queued after it, which the client's query wakes the compute for and the reconnecting worker drains. The worker and the client both run `databaseCheckConfig(url)` (`hostCheck` and `hostCheckWorkflows`, no root), so the client's runs are of the worker's version; the kit stops its worker.

```ts
const client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
const results = await checkDatabase({ type, apply, url, suspend, client });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeDatabase(name?)` is a database of the test Postgres (`testdb.database` at `testDatabaseUrl(name)`, made by its `create` and dropped by its `delete`) that pauses: `suspend()` drops every connection to it, as a Neon compute's suspend does, and resolves to how many it dropped; `remove()` drops the database; its `storeUrl` stores the URL as `SANOMA_DATABASE_URL_<EXPORT>`. `connector` is for a config, `driver` for calling its operations directly.
