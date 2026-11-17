---
title: Workers and apps for a test
description: "Part of sanoma (npm install sanoma). sanoma/testing/harness, /replay, /scenarios and /features need vitest, and /replay msw too."
sidebar:
  order: 2
---

Part of `sanoma` (`npm install sanoma`). `sanoma/testing/harness`, `/replay`, `/scenarios` and `/features` need `vitest`, and `/replay` `msw` too: optional peers, installed beside it by a repo that tests with them.

## A worker for a test

`startTestWorker(config, { databaseUrl, ...options })` calls `startWorker` with test defaults: the database `databaseUrl`, which is required, and, unless the config has one, a fresh in-memory ledger. `testWorkerConfig(config, databaseUrl)` is that config, for a worker started another way (`inProcessHost` supervises one). Tests are kept apart by database, not by app name: give each test file (or each `describe` that starts a worker) a database of its own, `testDatabaseUrl("announce")`, since two sharing one would recover each other's runs; the app keeps its name, its root's `package.json`'s. A `databaseUrl` in the config is ignored, so a test can spread the project's own config without reaching its real database. The other options (`promote`, `logLevel`) go to `startWorker`.

`testDatabaseUrl(suffix)` is `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the database name. Give each test file its own suffix, one no other file in the repository uses: files run at once, and two on one database would recover each other's runs. DBOS creates the database if it is missing.

`withFake(connector, fake)` is the connector set up with that fake instead of the one its package attaches, so live runs call it, and sandbox runs too, since its maker gives this very one: what a test that seeds or reads a fake passes in `connectors`. Swapping the driver alone, `withSetup(connector, { driver: () => fake.driver })`, keeps the package's maker, so each sandbox run has a fake of its own.

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

`findSentinels(databaseUrl, sentinels)` reads every column of a string, JSON, XML, array, composite or other non-numeric type (`text`, `varchar`, `citext`, `jsonb` and the like, as text) of every table in every schema of a database but Postgres's own, the company's tables, DBOS's and a store's alike, found through the catalog (a table the role cannot read fails the call, never left out), and returns `{ schema, table, column, sentinel }` for each column that holds one of `sentinels`. A test gives a credential a value nothing else would write (12 characters or more of letters, digits and `_ . : ~ + / = -`, which JSON writes as they are; another is refused), runs what handles it, and expects none: `expect(await findSentinels(url, sentinels)).toEqual([])` fails naming each place. Bytes (`bytea`) are not read, and a value the store keeps sealed is no hit, so the credentials table is read with the rest.

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
