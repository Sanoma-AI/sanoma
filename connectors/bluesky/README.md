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

## Driver

`@sanoma/connector-bluesky/driver` posts with the official [`@atproto/api`](https://www.npmjs.com/package/@atproto/api), whose client is generated from the Lexicon schemas. Pass it to the worker from your config (workflows may not import it):

```ts
import { blueskyDriver } from "@sanoma/connector-bluesky/driver";

const drivers = [blueskyDriver()]; // or blueskyDriver({ timeoutMs: 5_000 }); the default is 10 s per request
```

It reads these when it is called, never at import:

| Variable               | What                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `BLUESKY_IDENTIFIER`   | The account's handle or email.                                                        |
| `BLUESKY_APP_PASSWORD` | An [app password](https://bsky.app/settings/app-passwords), not the account password. |
| `BLUESKY_SERVICE`      | Optional. The PDS or entryway to log in to; default `https://bsky.social`.            |

It signs in with the app password, keeps the session for the life of the driver, and lets `@atproto/api` refresh it when the access token expires: Bluesky allows 30 logins per 5 minutes and 300 a day per account, fewer than a long-lived worker may post. If the refresh token has expired or been revoked, the next call logs in again. Bluesky's [OAuth](https://docs.bsky.app/docs/advanced-guides/oauth-client) needs a hosted client metadata document, a browser redirect and a session store, which a worker posting to its own account does not have; `@atproto/api` marks app-password sessions deprecated in favour of OAuth, so this may change. Any account can post with an app password: there is no approval or paid tier.

URLs and @mentions in the text become links (`RichText.detectFacets`); a mention whose handle does not resolve is posted as plain text. The reply's `url` is `https://bsky.app/profile/<handle>/post/<rkey>`.

Bluesky's errors become a `DriverError` with its HTTP `status` and its `error` name as `vendorCode` (`InvalidRequest`, `RateLimitExceeded`, ...). A timeout, a lost connection, a 429 and a 5xx are retryable; any other 4xx is not. A missing variable fails without calling Bluesky, naming it. Writes are limited to 5,000 points an hour and 35,000 a day per account, a post costing 3 ([rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits)); a 429's message says when the limit resets.

### One post per call

`bluesky.post.create` is not idempotent, so the runtime never retries it. A worker that crashes after Bluesky replied but before the reply was recorded runs the call again on recovery, though. The driver makes that safe: the post's record key is a TID derived from the call's idempotency key, so every try of one call names the same record, and a repository holds one record per key. When the create fails, the driver looks that key up; if the post is there, it returns it instead of posting again. TIDs are the key type posts declare, a client may choose them, and their timestamps are [not validated anywhere in the network](https://docs.bsky.app/docs/advanced-guides/timestamps), so this key's timestamp is a hash, not the time of posting (`createdAt` is).

### Testing the driver

`test/driver.test.ts` replays recorded XRPC replies from `test/fixtures/` with [msw](https://mswjs.io), so it needs no account. To run it against Bluesky, posting a few test posts to the account:

```sh
SANOMA_LIVE=1 BLUESKY_IDENTIFIER=you.bsky.social BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx pnpm vitest run connectors/bluesky
```

Add `SANOMA_RECORD=1` to rewrite the fixtures of the tests Bluesky can reproduce from its replies. The account's DID, handle, email, tokens, keys and CIDs are replaced with placeholders before a fixture is written; check the diff, and run `pnpm format`, before committing. The error cases (400, 429, 502, a timeout, a wrong password) stay as written.

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
