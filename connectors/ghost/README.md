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

The logo the app shows beside these operations is Ghost's glyph from [simple-icons](https://simpleicons.org/?q=ghost) (CC0), in near-black or white. It is there only to identify the service an operation calls. Ghost is a trademark of Ghost Foundation.

## Driver

`@sanoma/connector-ghost/driver` calls the [Ghost Admin API](https://docs.ghost.org/admin-api/). Pass it to the worker from your config (workflows never import it; the lint refuses that):

```ts
import { ghostDriver } from "@sanoma/connector-ghost/driver";

export default defineConfig({ connectors: [ghost], drivers: [ghostDriver()] /* , ... */ });
```

- `post.create` posts the HTML with `?source=html`, which Ghost converts to its editor format (lossy; see [Creating a post](https://docs.ghost.org/admin-api/posts/creating-a-post)). A draft's `url` is its preview link; it becomes the public URL when published.
- `post.publish` reads the post, then saves it with `status: "published"` and the `updated_at` it read, which Ghost requires to refuse a save over someone else's. If someone saved the post in between (`UPDATE_COLLISION`), it reads the post again and tries once more. Publishing sends no newsletter email: Ghost emails a post only when a `newsletter` is named.

### Environment

It reads two environment variables on every call, never when the config loads:

| Variable              | What it is                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `GHOST_ADMIN_URL`     | The site's admin URL, such as `https://example.ghost.io` (on Ghost(Pro), the `ghost.io` one). |
| `GHOST_ADMIN_API_KEY` | A custom integration's Admin API key, `<id>:<secret>`.                                        |

To make the key: in Ghost Admin, **Settings → Integrations → Add custom integration**, name it, and copy its **Admin API key** (not the Content API key). A missing or malformed variable fails the call, naming the variable, and is not retried.

### Idempotency

Ghost takes no idempotency key, and the runtime never retries `post.create`. If its reply is lost, the run fails and a draft stays in Ghost; the next run makes a new one. A draft is not visible on the site; delete it in Ghost Admin. `post.publish` returns a post that is already published as it is, without saving it, so a retry after a lost reply changes nothing; so too a post Ghost sent as an email only (`status: "sent"`), which is not a draft.

### Errors and retries

A timeout (10 s; `ghostDriver({ timeoutMs })` changes it), a network failure, a 408, a 429 or a 5xx is retryable; any other 4xx is not. A failure carries Ghost's HTTP `status` and, as `vendorCode`, its error `code` when it has one (`UPDATE_COLLISION`) or else its `type` (`ValidationError`, `UnauthorizedError`). Ghost documents no rate limit for the Admin API; Ghost(Pro) may answer 429 to protect itself.

### Plan

You need a Ghost site of your own. Self-hosted Ghost is free and open source (`docker run -p 2368:2368 -e NODE_ENV=development ghost:6-alpine` runs one locally). Ghost(Pro) has a free trial but no free plan, and its Starter plan has no custom integrations or Admin API: you need Publisher or above ([pricing](https://ghost.org/pricing/)).

### Testing the driver

`test/driver.test.ts` replays Ghost's recorded replies (`test/fixtures`) with [msw](https://mswjs.io): `pnpm vitest run connectors/ghost` needs no site. With `SANOMA_LIVE=1` the same tests call a real site instead, creating posts titled `sanoma test <timestamp>`, publishing some, and deleting them at the end; a missing variable fails the run. `SANOMA_LIVE=1` is the only switch, in CI as anywhere:

```sh
SANOMA_LIVE=1 GHOST_ADMIN_URL=https://example.ghost.io GHOST_ADMIN_API_KEY=<id>:<secret> pnpm vitest run connectors/ghost
```

Add `SANOMA_RECORD=1` to rewrite the fixtures from that site's replies. They are scrubbed as they are written: only the fields the driver reads are kept (no authors or emails), every URL is put on `https://blog.example.test`, and ids are renumbered. Read the diff, and run `pnpm format`, before you commit it. The error cases (429, 503, a timeout, a collision) are not rewritten: they only replay. `update-collision.json` was taken by hand from a local Ghost, since a test cannot make Ghost collide on cue.

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
