# @sanoma/testing

Helpers for testing [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows) workflows without vendor accounts.

## Install

Private to this repository: its tests import it through the workspace, and it is not published.

## A worker for a test

`startTestWorker(config, { databaseUrl, ...options })` calls `startWorker` with test defaults: the database `databaseUrl`, which is required, and, unless the config has one, a fresh in-memory ledger. Tests are kept apart by database, not by app name: give each test file (or each `describe` that starts a worker) a database of its own, `testDatabaseUrl("announce")`, since two sharing one would recover each other's runs; the app keeps its name, its root's `package.json`'s. A `databaseUrl` in the config is ignored, so a test can spread the project's own config without reaching its real database. The other options (`promote`, `logLevel`) go to `startWorker`.

`testDatabaseUrl(suffix)` is `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the database name. Give each test file its own suffix, so files don't recover each other's runs. DBOS creates the database if it is missing.

`withFake(connector, fake)` is the connector set up with that fake instead of the one its package attaches, so live runs call it, and sandbox runs too, since its maker gives this very one: what a test that seeds or reads a fake passes in `connectors`. Swapping the driver alone, `withSetup(connector, { driver: () => fake.driver })`, keeps the package's maker, so each sandbox run has a fake of its own.

`ensureBuilt(pkgDir, outputs, build)` runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` is missing or older than a file under its `src/`, for tests of what a package ships from `dist/`. `waitFor(get, done?, timeoutMs?)` calls `get` every 100 ms until `done` holds for its value (by default, until it is truthy), returns that value, and throws after `timeoutMs` (default 15 seconds) naming the last one.

```ts
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { fakeResend } from "@sanoma/connector-resend/fake";
import { type FakeCall, startTestWorker, testDatabaseUrl, withFake } from "@sanoma/testing";
import { allowAll } from "@sanoma/workflows";
import announce from "./workflows/announce.ts";

const calls: FakeCall[] = [];
const blog = fakeGhost({ calls });
const email = fakeResend({ calls });
const worker = await startTestWorker(
  { workflows: [announce], connectors: [withFake(ghost, blog), withFake(resend, email)], policy: allowAll },
  { databaseUrl: testDatabaseUrl("announce") }, // the database this file's tests run on
);

// ...start a run and wait for it to finish, then:
calls.map((c) => c.op); // ["ghost.post.create", "resend.broadcast.create", ...]
Object.values(email.state.broadcasts).map((b) => b.status); // ["sent"]
await worker.stop();
```

## A test app

`@sanoma/testing/harness` starts a worker and its clients for the tests of a `describe` (or a file), and stops them after (install `vitest` and `@dbos-inc/dbos-sdk` beside it). `useTestApp(config, { databaseUrl, ...options })` takes `startTestWorker`'s arguments and returns a `TestApp`:

| Member      | What it is                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`    | The config the worker and the clients share: yours, with `ledger` (default `memoryLedger()`) and `databaseUrl` (the option's) filled in once.                                        |
| `client`    | A `SanomaClient` of the worker: start runs, decide approvals, read the ledger.                                                                                                       |
| `raw`       | A `DBOSClient` of the same app, which sends messages and reads a run's steps without `SanomaClient`'s checks.                                                                        |
| `stop()`    | Stops the worker, as a process that stopped would.                                                                                                                                   |
| `restart()` | Stops the worker (unless `stop` did) and starts another on the same config and ledger, as a restarted process would: the runs it had in progress resume, and their records are kept. |

`client` and `raw` throw "is not started" outside the tests. Fakes a test reads are yours: create them beside the call, pass them with `withFake`, and reset them in your own `beforeEach`.

```ts
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";
import { testDatabaseUrl, withFake } from "@sanoma/testing";
import { useTestApp } from "@sanoma/testing/harness";
import { allowAll } from "@sanoma/workflows";
import { beforeEach, expect, it } from "vitest";
import publish from "./workflows/publish.ts";

const blog = fakeGhost();
const app = useTestApp(
  { workflows: [publish], connectors: [withFake(ghost, blog)], policy: allowAll },
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

Each connector carries its fake, and ships it at its own `/fake` entry, not in this package: `import { fakeGhost } from "@sanoma/connector-ghost/fake";`. Install the connectors you use; their READMEs ([Ghost](https://www.npmjs.com/package/@sanoma/connector-ghost#testing), [Resend](https://www.npmjs.com/package/@sanoma/connector-resend#testing), [Bluesky](https://www.npmjs.com/package/@sanoma/connector-bluesky#testing), [GitHub](https://www.npmjs.com/package/@sanoma/connector-github#testing), [Stripe](https://www.npmjs.com/package/@sanoma/connector-stripe#testing)) say what each fake holds and adds. Each returns:

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

To write a fake for another connector, use `defineFake(connector, { initial, ops })` from `@sanoma/workflows/fake`. `ops` gets the state and implements every operation, typed by the connector.

`fakeMarketingVendors` is gone: compose the fakes you need, passing them one `calls` array, as in the example above.

## Replaying a vendor's API

`@sanoma/testing/replay` tests a driver against a vendor's recorded replies, with [msw](https://mswjs.io) (install `msw` and `vitest` beside it). Call `replay(options)` once at the top of a test file: it starts msw for the file and returns `play`, `fixture`, `sent`, `exchanges` and the msw `server`.

```ts
import { replay } from "@sanoma/testing/replay";

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

`@sanoma/testing/scenarios` runs a config's [scenarios](https://www.npmjs.com/package/@sanoma/workflows#scenarios-and-sandbox-runs) as vitest tests (install `vitest` and `@dbos-inc/dbos-sdk` beside it). Each scenario is a sandbox run: the worker calls fakes of its own, made by the makers the connectors carry, never a driver.

`describeScenarios(config, options)` compiles the `.feature` files in `scenarios/` in the config's root with Cucumber, so a test file awaits it at its top level, and registers a test for each scenario, in a `describe` per file, each over `runScenario` from `@sanoma/workflows/scenarios` (the one implementation; `runScenarios` there, which `sanoma check` runs, needs no vitest); it throws, naming the root or the directory, when the root has no `scenarios/` or it holds no scenarios. A test starts the scenario's sandbox run, decides its approvals as the scenario says, and fails listing each `Then` step that did not hold, with why (Cucumber runs them in order, so the ones after a failure say `not checked (an earlier step failed)`). A file that does not load (a step no rule matches, bad JSON, a name used twice) is a failing test named after the file, whose message names the file (and the line, for a step or JSON error). It starts one [test app](#a-test-app) for all its scenarios, before them, with `useTestApp(config, options)`, and stops it after, on `options.databaseUrl`, as for `startTestWorker`. `options.startedBy` starts the runs (default `{ id: "scenarios" }`), and `options.timeoutMs` is how long each may take (`drive`'s, 15 seconds by default); the tests it registers get twice that, so `drive`'s error is the one you see.

```ts
// test/scenarios.test.ts
import { testDatabaseUrl } from "@sanoma/testing";
import { describeScenarios } from "@sanoma/testing/scenarios";
import { memoryLedger } from "@sanoma/workflows";
import config from "../sanoma.config.ts";

await describeScenarios({ ...config, ledger: memoryLedger() }, { databaseUrl: testDatabaseUrl("scenarios") });
```

A company config spread into `describeScenarios` keeps its `ledger`, so pass `ledger: memoryLedger()`, as above, to keep test runs out of the project's ledger.

Besides a run's calls and outcome, a scenario can say what the policy did and, with the vendors' fakes holding what the data files declare, what the built-in [drift](https://www.npmjs.com/package/@sanoma/workflows#drift) check finds (the full list of steps is in the workflows package):

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

`runScenario(scenario, { client, scope, startedBy?, timeoutMs? })`, re-exported from `@sanoma/workflows/scenarios`, runs one scenario against a worker you started, with a `SanomaClient` of it, and returns `{ runId, run, ledger, checks }`: the run's id, its summary, its ledger records and `check(scope, scenario, ledger)`. `timeoutMs` goes to `drive`. Load the scenarios with `await loadScenarios(scope)` from `@sanoma/workflows/scenario`, `scope` being `resolveConfig(config)`.

## A connector's own features

`@sanoma/testing/features` runs a connector's own feature files, which test its operations with its [steps](https://www.npmjs.com/package/@sanoma/workflows#steps-a-connector-ships) and the generic ones (`{op} is called with`, `it returns`, `it fails with status {int}`), as vitest tests. `describeFeatures(connector, { features, replay })` registers a `describe` per target and a test per scenario in each, in Cucumber, its `When` steps calling the operation directly (no worker, no policy):

- `fake`: a new fake of the connector's for each scenario.
- `replay`: the connector's driver over its vendor's recorded replies, with `replay`'s options (the driver tests' own, so both replay alike). Each scenario plays the fixture named after it, its name in lower case with each run of other characters a `-` (`Publish draft` plays `publish-draft.json`); one with no recording is tagged `@fake-only`, and its replay test is skipped. A missing fixture fails the test, saying so. With `SANOMA_LIVE=1` the replay tests are skipped: features never call a vendor or record.

A scenario's checks must hold on both targets, whose ids differ: name what a `Given` returned (`as`) and use its fields in a later table (`| id | $draft.id |`), and check fields both return (`it returns` then `| status | published |`), not ids.

```ts
// connectors/ghost/test/features.test.ts
import { describeFeatures } from "@sanoma/testing/features";
import { ghost } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

describeFeatures(ghost, { features: new URL("../features/", import.meta.url), replay: replayOptions });
```

Status: early (0.x). License: Apache-2.0.
