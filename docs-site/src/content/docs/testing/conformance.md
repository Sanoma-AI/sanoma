---
title: Conformance suites
description: "sanoma/testing/features runs a connector's own feature files, which test its operations with its steps and the generic ones ({op} is called with, it returns, it fails with status {int}), as vitest tests."
sidebar:
  order: 4
---

`sanoma/testing/features` runs a connector's own feature files, which test its operations with its [steps](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#steps-a-connector-ships) and the generic ones (`{op} is called with`, `it returns`, `it fails with status {int}`), as vitest tests. `describeFeatures(connector, { features, replay })` registers a `describe` per target and a test per scenario in each, in Cucumber, its `When` steps calling the operation directly (no worker, no policy):

- `fake`: a new fake of the connector's for each scenario.
- `driver`: the connector's driver over its vendor's recorded replies, with `replay`'s options (the driver tests' own, so both replay alike). Each scenario plays the fixture named after it, its name in lower case with each run of other characters a `-` (`Publish draft` plays `publish-draft.json`); one with no recording is tagged `@fake-only`, and runs on the fake alone. A missing fixture fails the test, saying so. With `SANOMA_LIVE=1` the driver calls the vendor, as the driver tests do, and with `SANOMA_RECORD=1` too, each scenario's replies are saved as its fixture. What a scenario creates is deleted after it, whether it passed or not (live, off the account; replaying, from the recording, which holds those deletes): each call of a resource type's `create` that returned an id, last first, through the type's `delete` with that id, as apply deletes (one an `update` replaced under a new id, by that id); one the scenario deleted itself is left out, and one that could not be deleted fails the test, saying what was not deleted. A fixture written by hand ends in those deletes too.

A scenario's checks must hold on both targets, whose ids differ: name what a `Given` returned (`as`) and use its fields in a later table (`| id | $draft.id |`), and check fields both return (`it returns` then `| status | published |`), not ids.

```ts
// connectors/ghost/test/features.test.ts
import { describeFeatures } from "sanoma/testing/features";
import { ghost } from "../src/index.ts";
import { replayOptions } from "./replay.ts";

await describeFeatures(ghost, { features: new URL("../features/", import.meta.url), replay: replayOptions });
```

Status: early (0.x). License: FSL-1.1-ALv2.

## A host's conformance

`sanoma/testing/host` decides whether a host (a resource type with a `host`, see [Hosts](/hosting/hosts/)) runs the company as the runtime needs. `checkHost(host)` drives one declared host through callbacks and a `SanomaClient` on its database, and returns each check as `{ name, ok, error? }`: the app answers `/healthz` at its `wakeUrl` (else its `url`), a queued run drains, the next trusted store read sees a credential change, a sleep survives a restart (`stop`, then `apply`, through the type's own operations), two deploys of a new commit at once leave the host on one revision (at least one finishes, and the other finishes too or fails at once as `superseded`, never by waiting out its time; it reaches the driver only when `apply` calls the type's operations itself, as the Cloudflare kit test does over its fake API; an apply through workflows (`throughWorkflows`) waits on the apply queue, and `fakeHost` and the Sanoma Cloud fake take one deploy at a time, so on those it says nothing of a real platform), a new commit on the source shows as drift at the host's `revision` that `apply` clears, and none of the host's `secrets` is in any ledger record. A host whose `capabilities.lifetime` is `stops-on-exit` also gives `suspend` (its runtime stopped as its platform may, its URL kept) and `running()` (whether its runtime runs now), has each start followed by a request to its `wakeUrl` (else its `url`, `/wake`), as the app's own writes are, and is checked for what one wake starts again: a run queued while it was stopped drains, and a sleep that ended while it was stopped continues; and for its end: it stops once its worker is idle, and a run queued while its worker stops (right after the worker records `sanoma_wakeup.stopped_at`) still runs. The host's config registers `hostCheck` (a connector whose driver reads `HOST_CHECK_TOKEN`) and `hostCheckWorkflows`, which the checks start runs of.

```ts
const results = await checkHost({ type, apply, stop, client, secrets, commit, drift });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeHost(start)` is a host in this process (`testhost.app`, every change a replace, no secret in its state; a declared `hostname` is reported as its `url`, `https://<hostname>`, and not served: its `wakeUrl` is where it answers) and `inProcessHost(config, databaseUrl, options?)` a `start` for it, as `sanoma worker` runs the company: a worker under `superviseWorker` (given `options`, such as `idleHorizonMs` and `stopCheckMs`), which stops itself when idle with a wakeup, and a server that answers `/healthz`, and `GET /wake` with 204, recording each as the running host's `wakes` and handing it to the supervisor, which starts a fresh worker when its last one stopped. When this process's environment names a host's wake route (`envWakeup`), the runtime ends once its worker stopped itself (`Running.exited`), its server closed first. `fakeHost(start, { lifetime: "stops-on-exit" })` is one that stops: its URL is a proxy on the declared port in front of the runtime, which ends with the runtime (`exited`) or on `stop()` while the proxy stays, and the next request starts it again, at the same revision with the same secrets, and is forwarded to it; its `type` reports the lifetime, `running()` whether a runtime runs behind it, and `wakes()` lists the wakes across its stops. `testRepository()` is a bare git repository to be a host's source, with `commit()`.

## A wakeup's conformance

`sanoma/testing/wakeup` decides whether a wakeup (a resource type with a `wakeup`, see [Hosts](/hosting/hosts/)) wakes a stopped host when the runtime asked it to, and only then. `checkWakeup(w)` registers wakes through `w.register` (the type's register operation, through its driver) and watches the `/wake` requests the host answers (`w.host.wakes()`), and returns each check as `{ name, ok, error? }`: a wake registered for 2 s from now arrives, not before its `at`; a wake registered before `w.host.stop()` starts the host again, and a run queued while it was stopped drains; a registration replaced before its `at` (2 s from now, by one 5 s from now) never wakes the host, the one that replaced it does; and a wake registered for a schedule's next fire, which falls while the host is stopped, runs that tick (it waits for the schedule's first tick while the host runs, since DBOS fires a missed tick from the last one fired, then for the next: up to twenty seconds). The client's config registers `wakeupCheckWorkflows` (`hostCheckWorkflows` and `wakeup-check-tick`, every ten seconds), with its root's `package.json` naming an app of its own for each run, so no earlier run's schedule is fired over.

```ts
const results = await checkWakeup({ type, host: { url, stop, wakes }, client, register });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeWakeup()` is a wakeup in this process (`testwakeup.timer`, its `host` a reference to a `testhost.app` declaration by its `url`): its driver's `register` arms one timer for the one timer apply created, replacing any armed before, that sends `GET {host}/wake` at `at`, again every 250 ms until the host answers. `fire()` sends the armed wake now; `registered()` lists the registrations it took; `close()` disarms it. Its tests run it over `fakeHost` with `stops-on-exit` and `inProcessHost`, and so does the stack test (`test/stack.test.ts`), with no account: the fake wakeup declared and applied for the host, a sleeping run and a schedule, the worker stopping itself and the process stopped in between, then woken.

## A database's conformance

`sanoma/testing/database` decides whether a database (a resource type with a `database`, see [Databases](/hosting/hosts/#databases)) holds the company as the runtime needs. `checkDatabase(db)` applies it (`db.apply()`, which must report it healthy), starts a worker on its URL (`db.url()`, the URL its `storeUrl` stores, read here for the test alone), and drives it through `db.client`, a `SanomaClient` on that URL, returning each check as `{ name, ok, error? }`: DBOS's tables migrate and the worker starts, the next trusted store read sees a credential change, and a queued run drains. A database whose `capabilities.pauses` is true also gives `suspend` (its compute suspended, every connection dropped) and is checked for a run queued after it, which the client's query wakes the compute for and the reconnecting worker drains. The worker and the client both run `databaseCheckConfig(url)` (`hostCheck` and `hostCheckWorkflows`, no root), so the client's runs are of the worker's version; the kit stops its worker.

```ts
const client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
const results = await checkDatabase({ type, apply, url, suspend, client });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeDatabase(name?)` is a database of the test Postgres (`testdb.database` at `testDatabaseUrl(name)`, made by its `create` and dropped by its `delete`) that pauses: `suspend()` drops every connection to it, as a Neon compute's suspend does, and resolves to how many it dropped; `remove()` drops the database; its `storeUrl` stores the URL as `SANOMA_DATABASE_URL_<EXPORT>`. `connector` is for a config, `driver` for calling its operations directly.

## A sandbox's conformance

`sanoma/testing/sandbox` decides whether a sandbox backend (a connector's `sandbox` half, see [Sandboxes](/hosting/hosts/#sandboxes)) gives the boxes a coding agent needs. `checkSandbox({ backend, capabilities, image, size, name?, hosts? })` discards the box `name` (default `sanoma-kit`), opens it with `hosts` (what it may reach; default `registry.npmjs.org`), and drives it through the contract alone, returning each check as `{ name, ok, error? }`: the box opens, stdout arrives before a command exits, stdin reaches `cat`, a written file reads back and runs with its mode, the box opens again with other hosts (whether it reaches only its hosts needs a network, which the kit does not use), a command killed mid-run exits non-zero, and `discard` leaves the next `open` empty; with `capabilities.snapshot`, that file and one a command wrote under `$HOME` survive `stop` and the next `open`; with `capabilities.port`, a `node` server in the box answers at what `expose` returns. Once no box opens, the rest fail at once. It discards the box at its end.

```ts
const results = await checkSandbox({ backend, capabilities: type.sandbox!.capabilities, image, size: 2 });
expect(results.every((r) => r.ok)).toBe(true);
```

`fakeSandbox(root?)` is `localBackend` (from `sanoma/workflows`) under a temporary `root`, with its type `testsandbox.box`: a box is the directory `<root>/<name>`, its home, its commands `bash -c` children in process groups of their own, its ports loopback's. `connector` is for a config, `backend` and `capabilities` for the kit; `remove()` deletes `root`.
