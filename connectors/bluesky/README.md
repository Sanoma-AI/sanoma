# @sanoma/connector-bluesky

[Bluesky](https://docs.bsky.app/docs/advanced-guides/posts) (AT Protocol) operations for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows).

```sh
npm install @sanoma/connector-bluesky
```

| Operation             | Effect    | What it does                                                |
| --------------------- | --------- | ----------------------------------------------------------- |
| `bluesky.post.create` | `publish` | Post publicly to the account's feed (up to 300 characters). |

```ts
import { bluesky } from "@sanoma/connector-bluesky";
import { defineWorkflow } from "@sanoma/workflows";

defineWorkflow({
  // ...
  uses: [bluesky.post.create],
  run: async (ctx, input) => ctx.bluesky.post.create({ text: input.text }),
});
```

This package declares the operations only. A driver that calls Bluesky is not included yet.

## Testing

`@sanoma/connector-bluesky/fake` is an in-memory Bluesky that posts nowhere: pass its driver to the worker, then check `state.posts` and `calls`.

```ts
import { bluesky } from "@sanoma/connector-bluesky";
import { fakeBluesky } from "@sanoma/connector-bluesky/fake";

const fake = fakeBluesky(); // or fakeBluesky({ file: ".sanoma/bluesky.json" }) to keep the state on disk
const worker = await startWorker({ connectors: [bluesky], drivers: [fake.driver] /* , ... */ });

// ...run a workflow, then:
fake.state.posts.map((p) => p.text); // ["Hello"]
```

A repeated idempotency key gets the first reply and posts nothing new. To test what a workflow does when Bluesky misbehaves, set up the next call to an operation before the run makes it:

- `fake.failNext("bluesky.post.create", err?)` throws `err` (default: a retryable `DriverError`).
- `fake.loseReply("bluesky.post.create")` posts, then throws, as if the reply was lost.
- `fake.rateLimit("bluesky.post.create")` throws a `DriverError` with status 429.
- `const release = fake.hold("bluesky.post.create")` makes the call wait until `release()`.

`fake.reset()` empties it between tests. Pass `{ calls }` with one array to several fakes to see their calls in one order.

`@sanoma/testing` re-exports `fakeBluesky` beside the other fakes, with `startTestWorker` and `testDatabaseUrl` to run a test's worker on a database of its own.

License: Apache-2.0.
