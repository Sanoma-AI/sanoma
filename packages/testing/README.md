# @sanoma/testing

Helpers for testing [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows) workflows without vendor accounts.

## Install

```sh
npm install --save-dev @sanoma/testing
```

## A worker for a test

`startTestWorker(config, options?)` calls `startWorker` with test defaults: the database `testDatabaseUrl(appName)` and, unless the config has one, a fresh in-memory ledger. `appName` is required and should be unique to the test file, since it names the file's database; two files sharing one would recover each other's runs. A `databaseUrl` in the config is ignored, so a test can spread the project's own config without reaching its real database; pass `options.databaseUrl` to use another one. The other options (`promote`, `logLevel`) go to `startWorker`.

`testDatabaseUrl(suffix)` is `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the database name. Give each test file its own suffix, so files don't recover each other's runs. DBOS creates the database if it is missing.

```ts
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { type FakeCall, fakeGhost, fakeResend, startTestWorker } from "@sanoma/testing";
import { allowAll } from "@sanoma/workflows";
import announce from "./workflows/announce.ts";

const calls: FakeCall[] = [];
const blog = fakeGhost({ calls });
const email = fakeResend({ calls });
const worker = await startTestWorker({
  workflows: [announce],
  connectors: [ghost, resend],
  drivers: [blog.driver, email.driver],
  policy: allowAll,
  appName: "announce-test", // and the database announce-test's tests run on
});

// ...start a run and wait for it to finish, then:
calls.map((c) => c.op); // ["ghost.post.create", "resend.broadcast.create", ...]
Object.values(email.state.broadcasts).map((b) => b.status); // ["sent"]
await worker.stop();
```

## Fake vendors

`fakeGhost`, `fakeResend` and `fakeBluesky` are re-exported from `@sanoma/connector-ghost/fake`, `@sanoma/connector-resend/fake` and `@sanoma/connector-bluesky/fake`. Each returns:

| Member                 | What it does                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `driver`               | The driver to pass to the worker.                                                              |
| `state`                | The vendor's state, such as `posts` or `broadcasts`.                                           |
| `calls`                | Every call received, in order, with its input and idempotency key.                             |
| `reset()`              | Empties the state, the remembered replies and the pending faults.                              |
| `failNext(opId, err?)` | The next call to `opId` throws `err` (default: a retryable `DriverError`) and changes nothing. |
| `loseReply(opId)`      | The next call to `opId` takes effect, then throws once, as if the reply was lost.              |
| `rateLimit(opId)`      | The next call to `opId` throws a retryable `DriverError` with status 429 and changes nothing.  |
| `hold(opId)`           | The next call to `opId` waits, before it takes effect, until the returned function is called.  |

A call that repeats an earlier call's idempotency key gets the earlier reply and changes nothing, so a test can check that a retried or replayed call has one effect.

Options: `{ file }` keeps the state and the replies in a JSON file, so they survive a worker restart and another process can read them. `{ calls }` logs into the array you pass, so several fakes share one ordered log.

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

Status: early (0.x). License: Apache-2.0.
