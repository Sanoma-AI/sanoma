# @sanoma-ai/connector-resend

[Resend Broadcasts API](https://resend.com/docs/api-reference/broadcasts) and [one-email send](https://resend.com/docs/api-reference/emails/send-email) operations for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows), and the [sending domain](#sending-domain) they send from, as a resource a data file declares.

## Usage

```sh
npm install @sanoma-ai/connector-resend
```

| Operation                 | Effect  | What it does                                                              |
| ------------------------- | ------- | ------------------------------------------------------------------------- |
| `resend.broadcast.create` | `write` | Create a broadcast to an audience. Nothing is sent.                       |
| `resend.broadcast.send`   | `send`  | Send a broadcast to every contact in its audience. Cannot be undone.      |
| `resend.emails.send`      | `send`  | Send one email to an address, or to a list of up to 50. Cannot be undone. |

```ts
import { resend } from "@sanoma-ai/connector-resend";
import { defineWorkflow } from "@sanoma-ai/workflows";

defineWorkflow({
  // ...
  uses: [resend.broadcast.create, resend.broadcast.send],
  run: async (ctx, input) => {
    const email = await ctx.resend.broadcast.create({
      audience: "newsletter",
      from: "Acme <news@acme.example>",
      subject: input.title,
      html: input.body,
    });
    return ctx.resend.broadcast.send({ id: email.id });
  },
});
```

`emails.send` takes `to` (an address, or a list of 1 to 50), `from`, `subject`, and `html`, `text` or both (Resend makes the text from the HTML when there is none), and returns the email's `{ id }`:

```ts
defineWorkflow({
  // ...
  uses: [resend.emails.send],
  run: async (ctx, input) =>
    ctx.resend.emails.send({
      to: input.email,
      from: "Acme <hello@acme.example>",
      subject: "Following up",
      text: `Hi ${input.name},…`,
    }),
});
```

## Sending domain

`resend.domain`, from `@sanoma-ai/connector-resend/resources`, is a domain Resend sends from, which a data file declares. Its `dns_records` are the records the domain's zone must hold, in the shape `dnsRecord` (from `@sanoma-ai/workflows`) gives them, so a zone's record set can take them whole, as `cloudflare.records` (in `@sanoma-ai/connector-cloudflare`) does through `from: "dns_records"`:

```ts
// resources/mail.ts
import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";
import { resend } from "@sanoma-ai/connector-resend/resources";

export const mail = resend.domain({ name: "sanoma.work" });
export const mailDns = cloudflare.records({ zone: "sanoma.work", name: "resend", records: mail });
```

| Field                | Who sets it         | What it is                                                                                                                                                                                                     |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | declared (identity) | The domain, in lower case: `example.com`, or a subdomain such as `mail.example.com` (Resend recommends one). Apply finds a domain of that name in the account and binds it.                                    |
| `region`             | declared, optional  | Where Resend sends from: `us-east-1` (Resend's default), `eu-west-1`, `sa-east-1` or `ap-northeast-1`.                                                                                                         |
| `custom_return_path` | declared, optional  | The Return-Path subdomain, `send` by default (`send.example.com`). A read takes it from the name of the domain's SPF MX record.                                                                                |
| `id`                 | Resend              | The domain's id, which the binding keeps.                                                                                                                                                                      |
| `status`             | Resend              | `not_started`, `pending`, `verified`, `failed`, `temporary_failure`, `partially_verified` or `partially_failed`.                                                                                               |
| `records`            | Resend              | The DNS records Resend asks for, as Resend gives them (`record`, `name`, `type`, `value`, `ttl`, `status`, `priority`).                                                                                        |
| `dns_records`        | Resend              | The same records as a zone holds them: `{ type, name, content, priority?, ttl }`, each `name` in full and in lower case with no trailing dot, a TXT record's text without quotes, `ttl` 1 for Resend's `Auto`. |

`name`, `region` and `custom_return_path` cannot change: a declaration that changes one plans a replace, which deletes the domain (Resend holds one domain of a name) and makes it again, with a new DKIM key, so new records; apply asks first.

Apply creates the domain, asks Resend to verify it at once, and reads it. Resend keeps checking for up to 72 hours, so the records the same apply writes a few seconds later verify it.

A domain is declared `verified`: any other status (`partially_verified` too) is drift (`status: verified → pending`), and apply plans an `update`, which asks Resend to verify it again.

A create tried again after its reply was lost finds the name registered already, and takes the domain of that name in the account. When another account holds it, the create is refused (`registered`): [claim it](https://resend.com/docs/dashboard/domains/claim) in Resend's dashboard.

Domains need a full-access API key: Resend answers a sending-only key's domain calls 401 `restricted_api_key`, which the driver refuses, saying so. Resend's free plan has 3 domains. Later: TLS (`tls`), open and click tracking and their subdomain, and receiving, which the type does not declare yet (Resend's defaults hold; a domain with any of them on has their records among `records` and `dns_records` too).

The logo the app shows beside these operations is Resend's lettermark from its [brand kit](https://resend.com/brand), black or white. It is there only to identify the service an operation calls.

## Driver

`@sanoma-ai/connector-resend/driver` calls Resend. The `resend` connector the package root exports carries it, made once per resolved config, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that):

```ts
import { resend } from "@sanoma-ai/connector-resend";

export default defineConfig({ workflows, connectors: [resend], policy });
```

`./driver` (`resendDriver`; `resendDriver({ timeoutMs })`, 15 s by default) and `./fake` (`fakeResend`) are internal entries, for tests.

`audience` is Resend's `segment_id` (Resend renamed audiences to segments). `from`, for a broadcast or an email, is the input's, a sender on a domain verified in Resend; Resend requires one, and the driver refuses a call without it, before calling Resend. `broadcast.send` returns `status: "queued"` when it sends: Resend replies with the id only and sends in the background.

The client is generated by [Hey API](https://heyapi.dev) from Resend's [OpenAPI spec](https://github.com/resend/resend-openapi), pinned to a commit and cut to the operations it calls in `openapi-ts.config.ts`: `pnpm run generate` rewrites `src/generated/`, which is never edited by hand.

### Environment

It reads this on every call, never when the config loads:

| Variable         | What it is                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `RESEND_API_KEY` | A Resend API key: a full-access one for [sending domains](#sending-domain), else sending access. |

When the key is unset, a call fails, not retryable, naming it; so does a `broadcast.create` or `emails.send` with no `from`. The driver declares the key in its `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)): the worker starts without it, warning, and the app's connector page shows its status and lets you set it.

### Idempotency

Resend documents `Idempotency-Key` for emails only, not broadcasts. `emails.send` sends the call's key, so a retried call (its reply lost, or its worker restarted) gets the first email's id back and sends nothing, for 24 hours, how long Resend keeps a key; the same key with another input fails for good (409 `invalid_idempotent_request`). The driver sends the call's key on the broadcast requests too, and names the broadcast after it so it traces to its run. A replayed `create` can leave a second draft, which sends nothing. `send` reads the broadcast first and sends only a `draft` or `scheduled` one, so a replayed `send` whose reply was lost sends nothing: it returns `queued` or `sent`, as Resend says the broadcast is, and fails for good on a `canceled` one. The read and the send are two requests, not one: two tries of one call running at once (a recovering worker re-running a call another worker still runs) could both read a draft and both send it, and Resend documents nothing that would stop the second.

### Errors and retries

A 408, a 429 (except `daily_quota_exceeded` and `monthly_quota_exceeded`), a 409 `concurrent_idempotent_requests` (a request with the same key still in flight), a 5xx, a timeout (15 s; `timeoutMs` changes it) or no reply is retryable; any other 4xx is not. `status` and `vendorCode` (Resend's error `name`) are kept. Resend allows 10 requests per second per team.

### Plan

Broadcasts are on the free Marketing plan (1,000 contacts, 3 segments, 3 domains), with no approval step documented. Sending to anyone but yourself needs a `from` on a domain you verified.

### Testing the driver

`test/driver.test.ts` replays Resend's recorded replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api), which says what `SANOMA_LIVE` and `SANOMA_RECORD` do: `pnpm vitest run connectors/resend` needs no account. Live, they create broadcasts and send one to a test segment, and send emails to Resend's test inbox, `delivered@resend.dev`:

```sh
SANOMA_LIVE=1 RESEND_API_KEY=re_... RESEND_TEST_AUDIENCE=<segment id> RESEND_TEST_FROM="Test <test@your-domain>" pnpm vitest run connectors/resend
```

A recording loses ids, addresses, the sender's domain and keys. The error cases, and the broadcasts that are no longer drafts, only replay.

The sending domain's replies (`features/domain.feature`'s fixtures and `domain-restricted-key.json`) are **written from Resend's API reference, not recorded**: no account was at hand when the type was written, so a reply the reference gets wrong is wrong here too, and the first live run re-records them. That run needs a full-access key and a throwaway domain you own, which it creates and deletes (one of the free plan's 3): put the domain in place of `example.com` in `features/domain.feature` for the run, and in `RESEND_TEST_DOMAIN`, which the scrub turns back into `example.com` (with each DKIM key's `p=…` as `p=redacted`), then put the feature back:

```sh
SANOMA_LIVE=1 SANOMA_RECORD=1 RESEND_API_KEY=re_... RESEND_TEST_AUDIENCE=<segment id> RESEND_TEST_DOMAIN=<domain> pnpm vitest run connectors/resend/test/features.test.ts
```

It checks what the reference leaves open: whether Resend names a subdomain's records relative to the zone (`send.mail`) or to the domain (`send`), the read's TXT quoting, and the 403 a name registered already gets. The driver's domain tests only replay.

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`resendSteps`, attached with `withSetup`), which a company's scenario can use beside the generic steps and other connectors' ones:

| Keyword | Step                                    | What it does                                                                                                       |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Given   | `a Resend broadcast {string}`           | Seeds a draft broadcast with that subject through `resend.broadcast.create`, named `broadcast` (`$broadcast.id`)   |
| Given   | `a Resend domain {string}`              | Seeds a sending domain of that name through `resend.domain.create`, asked to verify, named `domain` (`$domain.id`) |
| Given   | `Resend fails to send once`             | The next `resend.broadcast.send` fails (`failNext`)                                                                |
| Then    | `the Resend broadcast {string} is sent` | The broadcast with that subject, seeded or created by the run, was sent                                            |
| Then    | `a Resend email to {string} is sent`    | The run sent an email to that address, alone or in its list                                                        |

`features/broadcast.feature` creates and sends a broadcast, `features/emails.feature` sends an email, and `features/domain.feature` creates, reads, imports, plans and deletes a sending domain, with these steps and the generic ones for an operation's own test, on the fake and on Resend's replies (`create-and-send.json`, `send-an-email.json`, and the domain's, written from the reference): `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). A scenario tagged `@fake-only` has no recording. The package ships `features/`.

## Testing

`@sanoma-ai/connector-resend/fake` is an in-memory Resend that emails nobody, the fake the connector carries: each sandbox run makes one of its own. A test that reads or seeds one attaches it to the connector itself, then checks `state.broadcasts`, `state.emails` (the emails sent, by id), `state.domains` (the sending domains, by id, as Resend gives them) and `calls`.

```ts
import { withSetup } from "@sanoma-ai/workflows";
import { resend } from "@sanoma-ai/connector-resend";
import { fakeResend } from "@sanoma-ai/connector-resend/fake";

const fake = fakeResend();
const worker = await startWorker({
  connectors: [withSetup(resend, { driver: () => fake.driver, fake: () => fake })],
  /* ... */
});

// ...run a workflow, then:
Object.values(fake.state.broadcasts).map((b) => b.status); // ["sent"]
fake.calls.map((c) => c.op); // ["resend.broadcast.create", "resend.broadcast.send"]
```

Like Resend, the fake refuses to send a broadcast twice, unless the second call repeats the first one's idempotency key: then it gets the first reply and nothing changes. To test what a workflow does when Resend misbehaves, set up the next call to an operation before the run makes it:

- `fake.failNext("resend.broadcast.send", err?)` throws `err` (default: a retryable `DriverError`).
- `fake.loseReply("resend.broadcast.send")` sends, then throws, as if the reply was lost.
- `fake.rateLimit("resend.broadcast.send")` throws a `DriverError` with status 429.
- `const release = fake.hold("resend.broadcast.send")` makes the call wait until `release()`.

A domain it makes has a DKIM key made from its id, an MX record `feedback-smtp.<region>.amazonses.com` (priority 10) and an SPF TXT record, named relative to the domain as Resend names them. Asked to verify, it stays `pending`, as at Resend until the zone holds the records: `fake.verifyDomain(id)` makes it and its records `verified`, `fake.failDomain(id)` `failed`. Like Resend, it holds one domain of a name. It does not refuse a send with no `from`, which the driver does.

`fake.reset()` empties it between tests. Pass `{ calls }` with one array to several fakes to see their calls in one order.

[`@sanoma-ai/testing`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md) (in the sanoma repository, not published) has `startTestWorker` and `testDatabaseUrl` to run a test's worker with the fake on a database of its own.

## Changes

- 0.5.0: the resource type `resend.domain`. **`RESEND_FROM` is no longer read**: a `broadcast.create` or `emails.send` with no `from` in its input is refused, so a config that relied on it passes `from`, a sender on a verified domain (a 0.x minor: `^0.4` does not take it). It needs `@sanoma-ai/workflows` 0.10.5 or later, for `from` references.

License: FSL-1.1-ALv2.
