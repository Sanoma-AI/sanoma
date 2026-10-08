# @sanoma/connector-ghost

[Ghost Admin API](https://ghost.org/docs/admin-api/) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-ghost
```

| Operation            | Effect    | What it does                                             |
| -------------------- | --------- | -------------------------------------------------------- |
| `ghost.post.create`  | `write`   | Create a draft post. Drafts are not visible on the site. |
| `ghost.post.publish` | `publish` | Publish a draft post on the site. Idempotent.            |

```ts
import { ghost } from "@sanoma/connector-ghost";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [ghost.post.create, ghost.post.publish],
  run: async (ctx, input) => {
    const post = await ctx.ghost.post.create({ title: input.title, html: input.body, status: "draft" });
    return ctx.ghost.post.publish({ id: post.id });
  },
});
```

This package declares the operations only. A driver that calls Ghost is not included yet.

## Testing

`@sanoma/connector-ghost/fake` is an in-memory Ghost: pass its driver to the worker, then check `state.posts` and `calls`.

```ts
import { ghost } from "@sanoma/connector-ghost";
import { fakeGhost } from "@sanoma/connector-ghost/fake";

const fake = fakeGhost(); // or fakeGhost({ file: ".sanoma/ghost.json" }) to keep the state on disk
const worker = await startWorker({ connectors: [ghost], drivers: [fake.driver] /* , ... */ });

// ...run a workflow, then:
Object.values(fake.state.posts).map((p) => p.status); // ["published"]
fake.calls.map((c) => c.op); // ["ghost.post.create", "ghost.post.publish"]
```

A repeated idempotency key gets the first reply and changes nothing, as a real vendor that dedupes would. To test what a workflow does when Ghost misbehaves, set up the next call to an operation before the run makes it:

- `fake.failNext("ghost.post.publish", err?)` throws `err` (default: a retryable `DriverError`).
- `fake.loseReply("ghost.post.publish")` publishes, then throws, as if the reply was lost.
- `fake.rateLimit("ghost.post.publish")` throws a `DriverError` with status 429.
- `const release = fake.hold("ghost.post.publish")` makes the call wait until `release()`.

`fake.reset()` empties it between tests. Pass `{ calls }` with one array to several fakes to see their calls in one order.

`@sanoma/testing` re-exports `fakeGhost` beside the other fakes, with `startTestWorker` and `testDatabaseUrl` to run a test's worker on a database of its own.

License: Apache-2.0.
