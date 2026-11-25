---
title: Workers and apps for a test
description: "Start a test worker, share fake vendors across clients, and check what survives a restart."
sidebar:
  order: 2
---

Install `sanoma` (`npm install sanoma`) to use the test worker helpers. If your tests import `sanoma/testing/harness`, `/replay`, `/scenarios`, or `/features`, install their optional peer `vitest` alongside it. The replay helpers also need `msw`.

## A worker for a test

Pass a dedicated test database to `startTestWorker(config, { databaseUrl, ...options })`. The helper ignores any `databaseUrl` in the supplied config, so you can reuse a company config safely. It preserves the app name from the root `package.json` and supplies a fresh in-memory ledger unless the config declares one. Options such as `promote` and `logLevel` pass through to `startWorker`.

If another helper starts the worker, use `testWorkerConfig(config, databaseUrl)` to get the same configuration. For example, `inProcessHost` can supervise a worker configured this way.

Give each test file or concurrently running `describe` its own database, such as `testDatabaseUrl("announce")`. Workers sharing a database can recover each other’s runs. `testDatabaseUrl(suffix)` appends `_<suffix>` to the database in `SANOMA_TEST_DATABASE_URL`, which defaults to `postgresql://postgres:dbos@localhost:5433/sanoma_test`. DBOS creates the database if needed.

`withFake(connector, fake)` is the connector set up with that fake instead of the one its package attaches, so live runs call it, and sandbox runs too, since its maker gives this very one: what a test that seeds or reads a fake passes in `connectors`. Swapping the driver alone, `withSetup(connector, { driver: () => fake.driver })`, keeps the package's maker, so each sandbox run has a fake of its own.

### Build outputs for tests

`ensureBuilt(pkgDir, outputs, build, sources?)` runs `build` (a command and its arguments) in `pkgDir` when one of `outputs` is missing or older than a file `sources` matches (globs in `pkgDir`; by default `src/**`), for tests of what a package ships from `dist/`; after a build, an output it left as it was (up to date) is marked built. `waitFor(get, done?, timeoutMs?)` calls `get` every 100 ms until `done` holds for its value (by default, until it is truthy), returns that value, and throws after `timeoutMs` (default 15 seconds) naming the last one.

```ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { resend } from "@sanoma-ai/connector-resend";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";
import { type FakeCall, startTestWorker, testDatabaseUrl, withFake } from "sanoma/testing";
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

## Finding a planted secret

`findSentinels(databaseUrl, sentinels)` reads every column of a string, JSON, XML, array, composite or other non-numeric type (`text`, `varchar`, `citext`, `jsonb` and the like, as text) of every table in every schema of a database but Postgres's own, the company's tables, DBOS's and a store's alike, found through the catalog (a table the role cannot read fails the call, never left out), and returns `{ schema, table, column, sentinel }` for each column that holds one of `sentinels`.

A test gives a credential a value nothing else would write (12 characters or more of letters, digits and `_ . : ~ + / = -`, which JSON writes as they are; another is refused), runs what handles it, and expects none: `expect(await findSentinels(url, sentinels)).toEqual([])` fails naming each place. Bytes (`bytea`) are not read, and a value the store keeps sealed is no hit, so the credentials table is read with the rest.

```ts
import { findSentinels, testDatabaseUrl } from "sanoma/testing";

const token = `SENTINEL-token-${crypto.randomUUID()}`;
// ...store it, run what uses it, then:
expect(await findSentinels(testDatabaseUrl("announce"), [token])).toEqual([]);
```

## A test app

`sanoma/testing/harness` starts a worker and its clients for the tests of a `describe` (or a file), and stops them after (install `vitest` and `@dbos-inc/dbos-sdk` beside it). `useTestApp(config, { databaseUrl, ...options })` takes `startTestWorker`'s arguments and returns a `TestApp`:

| Member              | What it is                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`            | The config the worker and the clients share: yours, with `ledger` (default `memoryLedger()`) and `databaseUrl` (the option's) filled in once.                                                                                                                                                                                                  |
| `client`            | A `SanomaClient` of the worker: start runs, decide approvals, read the ledger.                                                                                                                                                                                                                                                                 |
| `raw`               | A `DBOSClient` of the same app, which sends messages and reads a run's steps without `SanomaClient`'s checks.                                                                                                                                                                                                                                  |
| `stop()`            | Stops the worker, as a process that stopped would.                                                                                                                                                                                                                                                                                             |
| `restart(options?)` | Stops the worker (unless `stop` did) and starts another on the same config and ledger, as a restarted process would: the runs it had in progress resume, and their records are kept. `options` (a worker's, as `useTestApp` takes them) change this worker's and the next ones', such as the repository (`source`) or the app's steps (`app`). |

`client` and `raw` throw "is not started" outside the tests. Fakes a test reads are yours: create them beside the call, pass them with `withFake`, and reset them in your own `beforeEach`.

```ts
import { ghost } from "@sanoma-ai/connector-ghost";
import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";
import { testDatabaseUrl, withFake } from "sanoma/testing";
import { useTestApp } from "sanoma/testing/harness";
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

## Run scenarios with Vitest

Install `vitest` and `@dbos-inc/dbos-sdk` in the test project. Use this entry point when the imported config lists the workflows under test. If the CLI discovers your workflows from files, run `npx sanoma check` to include them.

```ts
// test/scenarios.test.ts
import { testDatabaseUrl } from "sanoma/testing";
import { describeScenarios } from "sanoma/testing/scenarios";
import { memoryLedger } from "sanoma/workflows";
import config from "../sanoma.config.ts";

await describeScenarios({ ...config, ledger: memoryLedger() }, { databaseUrl: testDatabaseUrl("scenarios") });
```

Await `describeScenarios` at the top level. It starts one test app on `options.databaseUrl` for the suite and stops it afterward. Pass `memoryLedger()` to keep test writes out of a configured project ledger.

Each feature in the root or an app becomes a test group, with one sandbox run per scenario. The runner sends the specified approvals and reports each failed expectation. A feature that cannot load gets a failing test named for the file. A root demo world gets a separate test that seeds its fakes. If the configured root has neither scenarios nor a world, registration throws.

`startedBy` supplies an ID or principal for scenarios without an actor and defaults to `scenarios`. `timeoutMs` defaults to 15 seconds for each run. The Vitest test gets twice that time so that a stalled run reports the step it was waiting on.
