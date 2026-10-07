# @sanoma/testing

Helpers for testing [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows) workflows without vendor accounts.

```sh
npm install --save-dev @sanoma/testing
```

## A worker for a test

`startTestWorker(config)` calls `startWorker` with test defaults: `databaseUrl` from `testDatabaseUrl(appName)` and a fresh in-memory ledger. `appName` is required and should be unique to the test file, since it names the file's database; two files sharing one would recover each other's runs.

`testDatabaseUrl(suffix)` is `SANOMA_TEST_DATABASE_URL` (default `postgresql://postgres:dbos@localhost:5433/sanoma_test`) with `_<suffix>` appended to the database name. Give each test file its own suffix, so files don't recover each other's runs. DBOS creates the database if it is missing.

```ts
import { ghost } from "@sanoma/connector-ghost";
import { resend } from "@sanoma/connector-resend";
import { type FakeCall, fakeGhost, fakeResend, startTestWorker, testDatabaseUrl } from "@sanoma/testing";
import announce from "./workflows/announce.ts";

const calls: FakeCall[] = [];
const blog = fakeGhost({ calls });
const email = fakeResend({ calls });
const worker = await startTestWorker({
  workflows: [announce],
  connectors: [ghost, resend],
  drivers: [blog.driver, email.driver],
  databaseUrl: testDatabaseUrl("announce"),
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

Status: early (0.x). License: Apache-2.0.
