# @sanoma/connector-resend

[Resend Broadcasts API](https://resend.com/docs/api-reference/broadcasts) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-resend
```

| Operation                 | Effect  | What it does                                                         |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `resend.broadcast.create` | `write` | Create a broadcast to an audience. Nothing is sent.                  |
| `resend.broadcast.send`   | `send`  | Send a broadcast to every contact in its audience. Cannot be undone. |

```ts
import { resend } from "@sanoma/connector-resend";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [resend.broadcast.create, resend.broadcast.send],
  run: async (ctx, input) => {
    const email = await ctx.resend.broadcast.create({ audience: "newsletter", subject: input.title, html: input.body });
    return ctx.resend.broadcast.send({ id: email.id });
  },
});
```

The logo the app shows beside these operations is Resend's lettermark from its [brand kit](https://resend.com/brand), black or white. It is there only to identify the service an operation calls.

## Driver

`@sanoma/connector-resend/driver` calls Resend. Workflows never import it; the config that starts the worker does:

```ts
import { resendDriver } from "@sanoma/connector-resend/driver";

const drivers = [resendDriver({ from: "Acme <news@acme.example>" })]; // `from`: the default sender
```

- **Env:** `RESEND_API_KEY`, read on every call. When it is unset, a call fails, not retryable, naming it.
- **Mapping:** `audience` is Resend's `segment_id` (Resend renamed audiences to segments). `from` comes from the input, else the driver's `from` option; Resend requires one. `send` returns `status: "queued"`: Resend replies with the id only and sends in the background.
- **Idempotency:** Resend documents `Idempotency-Key` for emails only, not broadcasts. The driver sends the call's key on both requests anyway, and names the broadcast after it so it traces to its run. A replayed `create` can leave a second draft, which sends nothing. A replayed `send` asks Resend to send the broadcast again; Resend does not document what it answers.
- **Errors:** a 429 (except `daily_quota_exceeded` and `monthly_quota_exceeded`), a 5xx, a timeout (15 s; `timeoutMs` changes it) or no reply is retryable; any other 4xx is not. `status` and `vendorCode` (Resend's error `name`) are kept. Resend allows 10 requests per second per team.
- **Free plan:** broadcasts are on the free Marketing plan (1,000 contacts, 3 segments, 3 domains), with no approval step documented. Sending to anyone but yourself needs a `from` on a domain you verified.

The client's types are generated from Resend's [OpenAPI spec](https://github.com/resend/resend-openapi), pinned to a commit and cut to the two operations in `openapi.redocly.yaml`: `pnpm run generate` rewrites `src/resend-api.d.ts`.

`pnpm vitest run connectors/resend` replays the replies in `test/fixtures`. To call Resend instead (never in CI), creating broadcasts and sending one to a test segment, and then to re-record the fixtures with ids, addresses and keys scrubbed:

```sh
SANOMA_LIVE=1 RESEND_API_KEY=re_... RESEND_TEST_AUDIENCE=<segment id> RESEND_TEST_FROM="Test <test@your-domain>" pnpm vitest run connectors/resend
SANOMA_LIVE=1 SANOMA_RECORD=1 RESEND_API_KEY=re_... RESEND_TEST_AUDIENCE=<segment id> RESEND_TEST_FROM=... pnpm vitest run connectors/resend
```

## Testing

`@sanoma/connector-resend/fake` is an in-memory Resend that emails nobody: pass its driver to the worker, then check `state.broadcasts` and `calls`.

```ts
import { resend } from "@sanoma/connector-resend";
import { fakeResend } from "@sanoma/connector-resend/fake";

const fake = fakeResend(); // or fakeResend({ file: ".sanoma/resend.json" }) to keep the state on disk
const worker = await startWorker({ connectors: [resend], drivers: [fake.driver] /* , ... */ });

// ...run a workflow, then:
Object.values(fake.state.broadcasts).map((b) => b.status); // ["sent"]
fake.calls.map((c) => c.op); // ["resend.broadcast.create", "resend.broadcast.send"]
```

Like Resend, the fake refuses to send a broadcast twice, unless the second call repeats the first one's idempotency key: then it gets the first reply and nothing changes. To test what a workflow does when Resend misbehaves, set up the next call to an operation before the run makes it:

- `fake.failNext("resend.broadcast.send", err?)` throws `err` (default: a retryable `DriverError`).
- `fake.loseReply("resend.broadcast.send")` sends, then throws, as if the reply was lost.
- `fake.rateLimit("resend.broadcast.send")` throws a `DriverError` with status 429.
- `const release = fake.hold("resend.broadcast.send")` makes the call wait until `release()`.

`fake.reset()` empties it between tests. Pass `{ calls }` with one array to several fakes to see their calls in one order.

`@sanoma/testing` re-exports `fakeResend` beside the other fakes, with `startTestWorker` and `testDatabaseUrl` to run a test's worker on a database of its own.

License: Apache-2.0.
