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

This package declares the operations only. A driver that calls Resend is not included yet.

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

License: Apache-2.0.
