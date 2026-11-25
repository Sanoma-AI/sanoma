---
title: Fake vendors and replay
description: "Simulate vendor state and failures in memory, or test a driver against recorded HTTP replies."
sidebar:
  order: 3
---

Use a connector’s fake to exercise workflow behavior with an in-memory vendor. To test the driver’s HTTP requests, use [recorded replies](#replaying-a-vendors-api).

Connector authors create the fake with `defineFake(connector, { initial, ops }, { calls? })` from `sanoma/workflows/fake` and attach its factory with `withSetup`. Each operation in `ops` works on the fake’s state and uses the same schema types as `defineDriver`. Repeating an idempotency key returns the original reply. Use `update(change)` to simulate a change at the vendor and `calls` to share an ordered log across fakes. The table below lists the available faults, including `failNext`, `loseReply`, `rateLimit`, and `hold`.

Shipped fakes such as `@sanoma-ai/connector-ghost/fake` use this API. The separate entry point keeps test tooling out of the runtime. The linter rejects it in workflow files.

For vendors that hold resources, `ResourceFake` defines `put`, `override`, and `remove` by resource type and import ID, using the resource’s field shape. The bridge’s `tfFake` in `sanoma/internal/bridge` implements it, so [scenario steps](/testing/scenarios/) can seed resources.

## Fake vendors

Each connector carries its fake, and ships it at its own `/fake` entry, not in this package: `import { fakeGhost } from "@sanoma-ai/connector-ghost/fake";`. Install the connectors you use; their READMEs ([Ghost](https://www.npmjs.com/package/@sanoma-ai/connector-ghost#testing), [Resend](https://www.npmjs.com/package/@sanoma-ai/connector-resend#testing), [Bluesky](https://www.npmjs.com/package/@sanoma-ai/connector-bluesky#testing), [GitHub](https://www.npmjs.com/package/@sanoma-ai/connector-github#testing), [Stripe](https://www.npmjs.com/package/@sanoma-ai/connector-stripe#testing)) say what each fake holds and adds.

Each returns:

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

To write a fake for another connector, use `defineFake(connector, { initial, ops })` from `sanoma/workflows/fake`. `ops` gets the state and implements every operation, typed by the connector.

`fakeMarketingVendors` is gone: compose the fakes you need, passing them one `calls` array, as in the example above.

## Replaying a vendor's API

`sanoma/testing/replay` tests a driver against a vendor's recorded replies, with [msw](https://mswjs.io) (install `msw` and `vitest` beside it). Call `replay(options)` once at the top of a test file: it starts msw for the file and returns `play`, `fixture`, `sent`, `exchanges` and the msw `server`.

```ts
import { replay } from "sanoma/testing/replay";

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

A fixture, `<name>.json`, is a list of exchanges: `{ method, path, status, headers?, body }`, where `path` is the URL's decoded path and query (the host is not compared) and `headers` keeps only rate-limit headers. `play(name)` answers the test's requests with them, in order; a request that is not next in the fixture, or an exchange no request asked for, fails the test. `play(name, exchanges)` serves a list the test builds instead, for the cases a vendor will not reproduce on cue.

`fill(exchange, sent)`, an option, fills a fixture's placeholders from the request it answers, such as an id the request chose. `sent` holds the requests the test made, bodies parsed; `exchanges` the replies they got.

Two variables change what the same tests do:

- `SANOMA_LIVE=1` calls the vendor instead: every request goes through to it. A run without the `needs` variables fails at once rather than replaying. Tests that only replay skip themselves with `it.skipIf(live)`.
- `SANOMA_RECORD=1`, with `SANOMA_LIVE=1`, rewrites each played fixture from the vendor's replies, passed through `scrub` first. Read the diff, and run `pnpm format`, before committing it.
