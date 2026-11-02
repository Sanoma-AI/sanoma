# @sanoma-ai/connector-cloudflare

[Cloudflare Containers](https://developers.cloudflare.com/containers/) as a host that stops when quiet, and its [Durable Object](https://developers.cloudflare.com/durable-objects/)'s [alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) as the wakeup that starts it again, for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows). Both are one Worker per company, `sanoma-<name>`, on the account's workers.dev subdomain. And a set of [DNS records](#dns-records) in one of the account's zones, such as the ones a sending domain asks for.

## Usage

```sh
npm install @sanoma-ai/connector-cloudflare
```

The three types are writable: `read` and `import` (effect `read`), and the change operations only the apply workflow may call, `plan` (effect `read`), `create`, `update` and `delete` (effect `write`). The container is a host ([Hosts](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#hosts)) and the alarm a wakeup, with one more operation, `register`, which the worker calls:

| Type        | Operations                                                                                | Import id       |
| ----------- | ----------------------------------------------------------------------------------------- | --------------- |
| `container` | `cloudflare.container.read`, `.import`, `.plan`, `.create`, `.update`, `.delete`          | its name        |
| `alarm`     | `cloudflare.alarm.read`, `.import`, `.plan`, `.create`, `.update`, `.delete`, `.register` | its host's URL  |
| `records`   | `cloudflare.records.read`, `.import`, `.plan`, `.create`, `.update`, `.delete`            | `<zone>/<name>` |

A data file declares them with the constructors in `@sanoma-ai/connector-cloudflare/resources`. Declaring the alarm is the whole switch for scaling to zero: without it, nothing starts a stopped container at a deadline, and a sleeping run waits for the next request.

```ts
// resources/infra.ts
import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";
import { secret } from "sanoma/resources";

export const host = cloudflare.container({
  name: "acme", // the Worker sanoma-acme, at https://sanoma-acme.<subdomain>.workers.dev
  image: "ghcr.io/sanoma-ai/runtime:0.7.0", // copied into the account's registry at apply
  source: repo, // a declared github.repository, or a clone URL
  ref: "main",
  port: 3000,
  secrets: {
    SANOMA_DATABASE_URL: secret("DATABASE_URL"),
    SANOMA_SECRETS_KEY: secret("SECRETS_KEY"),
    SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN", { generate: true }), // made at the first apply
  },
});
export const wakeup = cloudflare.alarm({ host });
```

| Field                  | What it is                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | The company's name, its identity: lowercase letters, digits and dashes, up to 56; the Worker and its application are `sanoma-<name>`                                    |
| `image`                | The Sanoma runtime image, pinned to a tag or digest, never `latest`: any registry's, which apply copies into the account's and pins by digest ([The image](#the-image)) |
| `source`               | The company repository: a clone URL, or a declared `github.repository`                                                                                                  |
| `ref`                  | The branch it runs, never a commit: apply resolves it and sets the hidden `revision`, so a merge is drift on the container                                              |
| `port`                 | The port the runtime listens on in the container (its `PORT`)                                                                                                           |
| `secrets`              | Environment variables, each a `secret(...)`: the Worker's secret bindings, write-only, never in an output, the ledger or a checkpoint                                   |
| `domains`              | Optional: a public site's domain, by site name, passed as `SANOMA_DOMAINS` and attached to the Worker by apply as a custom domain ([Custom domains](#custom-domains))   |
| `id`, `url`, `healthy` | Cloudflare's: the application's id, the Worker's workers.dev URL, and whether it answers                                                                                |

The host's outputs are `{ url, revision, healthy }`. Its capabilities: stops when quiet, a public URL, it runs an image rather than building one, no fixed egress. `healthy` is the application existing and the Worker answering `/__sanoma/health`, which does not start a stopped container: a stopped host is healthy, and a read or a drift check leaves it stopped.

The alarm's field is `host`, the container it wakes (its URL); its state is `{ host, at, rang, healthy }`, the wake it holds, when its alarm last rang the host's `/wake` for it, and whether the host's Worker took the company's token. Its optional `token`, a `secret("NAME")`, names the secret that holds the host's wakeup token, by default `SANOMA_WAKEUP_TOKEN`: a workflow that makes a host and its alarm for each of several companies, outside any data file, gives each its own (`token: secret("CLOUD_ACME_WAKEUP_TOKEN")`, the secret the host's `secrets` give as `SANOMA_WAKEUP_TOKEN`). `create` mints the token there when none is stored, and its state then carries the name as `token`, so a `read`, `update` or `delete` given that state sends the same token; one given only an id uses the default. A data file leaves `token` out: apply reads and deletes an alarm by its id alone, so `plan` refuses another name. `register` takes `{ at }`, an ISO 8601 time, which replaces the wake the Worker held: a wake is "resume if stopped", so one that rings late, twice or for a replaced registration starts a worker that finds nothing to do and stops again. It names no host: on the host, the worker reads the host's URL from `SANOMA_HOST_URL`, which the Worker gives the container; off it, from the credential `alarm.create` stored. A runtime whose data files declare no wakeup, but whose environment has both `SANOMA_HOST_URL` and `SANOMA_WAKEUP_TOKEN` (a host Sanoma Cloud made), registers at the same route itself, with no connector call (`envWakeup` in `@sanoma-ai/workflows`).

The logo is Cloudflare's cloud from [Simple Icons](https://simpleicons.org/?q=cloudflare) (CC0), there only to identify the service an operation calls.

## The Worker

The package ships the Worker it uploads, `worker/`: `index.js`, which exports the Durable Object class `SanomaInstance` over `DurableObject` from `cloudflare:workers`, and `instance.js`, the object's code with no imports (typed by `instance.d.ts`), which the fake runs in Node so both kits check the code Cloudflare runs. Every request to the Worker goes to its one object, which:

- starts the container on a request at the Worker's `SANOMA_REVISION` and the image its upload names (`ctx.container.images.runtime`: the copy, pinned by digest), as a `standard-1` instance (½ vCPU, 4 GiB: the policy refuses `basic`), with the Worker's text bindings (plain and secret) as its environment and both as labels (the image's as a hash, since a label holds 64 bytes); a running container that does not carry both is destroyed and started again (a deploy);
- waits for the container's `/healthz` (up to ten minutes, the clone and install included), sets its inactivity timeout to ten minutes, and proxies the request to its `port` with the Host it was asked for and `x-forwarded-proto` (the port's fetch reaches the container whatever the URL's host, which becomes the request's Host header: so the company serves the public site declared on a domain);
- answers `GET /__sanoma/health` with `{ revision, running }` without starting the container, and with `?start=1` once the container answers, which is what a create or update waits for;
- holds the company's one wake at `/__sanoma/wake`, with `Authorization: Bearer <SANOMA_WAKEUP_TOKEN>`: `GET` shows `{ at, rang? }`, `PUT { at }` replaces it and sets the object's alarm, `DELETE` clears it. Without the token among the host's secrets it answers 404, with another one 401;
- at the alarm, starts the container and calls its `/wake`, then notes when (`rang`); a failure throws, so Cloudflare rings the alarm again.

Cloudflare stops the container after ten quiet minutes; the object, its storage and its alarm stay, and the next request or alarm starts the container again. The application is of the `durable_object` scheduling policy (public beta, the one Cloudflare documents for new applications; it refused `default` on the account the connector was first run on): the object starts its container, with the image and the instance type it names, so the application is only a name and the object's namespace, and has no image, versions or rollouts. A create, in Wrangler's order, copies and pins the image and waits until Cloudflare prepared it ([The image](#the-image)), uploads the Worker with the object's migration (`new_sqlite_classes`) and its class as a container's with that image (`containers: [{ name, class_name, images: { runtime } }]`, as Wrangler sends it), turns its workers.dev URL on, makes the application for the object's namespace (`{ name, scheduling_policy: "durable_object", durable_objects: { namespace_id } }`, the `namespace_id` the Worker's settings then show), and uploads the Worker once more: the object learns which application backs its namespace only from a deployment made after the application exists, and without that upload every start answers "There is no container application assigned to this Durable Object namespace", for good (found on the first real deploy, 2026-10-29); an update does the same, except that it leaves the application as it is: a new image is a new upload naming it, and the object destroys a container started at another and starts it again at the next request. Either waits for the Worker to answer at the new revision. The policy is fixed once an application is made, and the object cannot start a container under another: one of the `default` policy under that name (none can be made any more) is deleted by hand before the apply. A secret's new value goes up with the next update for another reason (a plan compares secret names, never values: the Worker's settings never show them), and a running container keeps the old one until it starts again. A delete detaches the custom domains the Worker was declared to serve, deletes the application, then the Worker with its object's storage. A Worker of that name that is not Sanoma's (no `SANOMA_INSTANCE` binding) reads as gone, and a create or a delete refuses to touch it.

## The image

A container of the `durable_object` policy runs an image of its own account's registry pinned by digest, `registry.cloudflare.com/<account id>/<repository>@sha256:<digest>`, never a tag, which Cloudflare stores and pulls without a limit (Docker Hub's pulls are not cached and are limited per address). So a create or an update first copies the declared image there and pins the copy by its manifest's digest, and the object starts that: `ghcr.io/sanoma-ai/runtime:0.8.1` becomes `registry.cloudflare.com/<account id>/sanoma-ai-runtime@sha256:…` (the path with `-` for `/`, copied as `:0.8.1`). An image in the account's registry by a tag is not copied: its manifest's digest is asked for (`docker-content-digest`); one there pinned by digest runs as it is, with no registry request. The copy is registry to registry in Node, no Docker: the source pulled anonymously (a public image; the token its registry's challenge names), the target pushed to with temporary credentials from `containers.registries.credentials.generate` (push and pull, an hour, never stored or logged). Each blob the account lacks is streamed across in one request of its known length, then the manifest, unchanged; when the account's manifest for that tag already has the source's digest, nothing is copied, and a digest-pinned source must answer that digest. Docker Hub is not copied from: declare `ghcr.io/sanoma-ai/runtime`. The source must be one image manifest (OCI or Docker v2), not an index: the release pushes one (`provenance: false`). Then the account prepares the pinned image to run (`POST …/containers/image-preparations { image }`, `containers.images.prepare`), asked again every two seconds until it is `ready`, as Wrangler does: an `error` fails the apply with Cloudflare's `reason`, not retryable, and fifteen minutes without `ready` fails it as retryable. Both come before the upload, so a copy or a preparation that fails leaves the Worker as it was.

The Worker's `SANOMA_IMAGE` binding holds the declared image and its upload the pinned copy, so a read reports the declared image, a plan and drift compare the declaration with it, and a declaration that names `ghcr.io` plans no change once applied. An image pushed by hand (`npx wrangler containers push`) is declared as the `registry.cloudflare.com/<account id>/...` reference Wrangler prints, and runs as it is, pinned; another account's is copied like any other registry's image.

## Scale to zero

1. **The connector.** Add `cloudflare` to the connectors in `sanoma.config.ts`: the worker on the host calls `cloudflare.alarm.register` through it.
2. **Credentials.** On the connector's page, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (below).
3. **Go live.** `infra.ts` declares the host with `SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN", { generate: true })` among its secrets (apply makes it), and, after it, `export const wakeup = cloudflare.alarm({ host })`. One apply makes the Worker, waits for it, then the alarm, which checks the Worker holds the token.
4. **A sleeping run.** Start a workflow that sleeps past ten quiet minutes. Before the container stops the worker registers the sleep's end; at `at` the object's alarm starts the container and calls `/wake`, and the run continues.

To stop scaling to zero, delete the `wakeup` line and `SANOMA_WAKEUP_TOKEN` from the host's secrets, and apply: the alarm is deleted, and the next request still starts the container. With the token left among the host's secrets, the runtime registers with the Worker's wake route itself (`envWakeup`), as a Sanoma Cloud company's does.

## Custom domains

Each hostname in `domains` is attached to the Worker as a [Workers custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) by a create or an update: Cloudflare then makes its DNS record and certificate and routes it to the Worker. The zone is the hostname's last two labels (`www.acme.example` is in `acme.example`), looked up in the account once per apex when a domain is to be attached (`GET /zones?name=&account.id=`); a hostname whose zone the account does not hold, or the token cannot read, is refused, naming the hostname and the zone, before anything changes. An update lists the Worker's attached domains first (`GET …/workers/domains?service=`), and only a missing one's zone is looked up; after the upload, each missing one is attached (`PUT …/workers/domains { zone_id, hostname, service }`), then the ones declared before and no longer are detached (`DELETE …/workers/domains/{id}`). A domain attached by hand and never declared is left alone. A read lists the Worker's attached domains too and shows only the declared ones attached, so a domain whose attach failed, or one detached by hand, is drift that the next apply attaches again. A delete detaches every declared one before the Worker goes. A container without `domains` makes none of these requests, unless it served some before, which are then detached. A zone such as `acme.co.uk`, whose apex is three labels, is not found yet.

## DNS records

`cloudflare.records({ zone, name, records })` is a set of DNS records in one of the account's zones, compared as a set, in no order. A sending domain's records are the case it is made for: `records` names a declared `resend.domain`, whose `dns_records` it then takes ([a field taken from another resource's state](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#resources)), or is a list written out.

```ts
// resources/infra.ts
import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";
import { resend } from "@sanoma-ai/connector-resend/resources";

export const mail = resend.domain({ name: "sanoma.work" });
export const mailDns = cloudflare.records({ zone: "sanoma.work", name: "resend", records: mail });
```

| Field                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zone`                  | The zone's name, as the account holds it (`sanoma.work`); changing it replaces the set                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `name`                  | The set's label (`resend`): lower case letters, digits, `-` and `_`. Its identity is `<zone>/<name>`; changing it replaces the set                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `records`               | The records, at least one: `{ type, name, content, priority?, ttl? }` each (`dnsRecord` from `@sanoma-ai/workflows`): TXT, MX, CNAME or CAA, the full name in lower case (the zone's name or one ending in it), a TXT record's text unquoted, a priority for MX, a ttl in seconds (1, automatic, when left out). One type, name and content declared twice with another ttl or priority, a name outside the zone, or a CNAME declared beside another record of its name, or two SPF policies (`v=spf1` TXT records) declared at one name, is refused, `invalid` |
| `zone_id`, `record_ids` | Cloudflare's: the zone's id, and each record's, in the order of `records` as a read gives them                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Ownership.** Every record the set writes carries the comment `sanoma:<zone>/<name>` (`sanoma:sanoma.work/resend`), in that case exactly, which is how a read finds its records (`GET /zones/{id}/dns_records?comment.exact=`): the set is the records that carry it, and none is gone. A record's comment holds 100 characters on a Free zone, so a set whose mark is longer is refused, `invalid`. A record without that comment is never changed or deleted, whoever added it, with one exception: a record identical to a declared one in type, name and content, and an MX record's priority (one added by hand before the set was declared), is adopted, patched to carry the comment and the declared ttl; so is one a changed record would be patched to, whose marked one is then deleted. An adopted record is the set's from then on: it carries the mark, so it changes with the set and is **deleted with it**, and the comment it had is replaced by the mark (the set finds its records by the exact comment, so it keeps no other). A record in the way of a declared one is refused, `conflict`, naming it, before anything is written, whether the declared one is to be posted or a marked one patched to it: a CNAME at the name (or a declared CNAME beside any record), another SPF policy (a `v=spf1` TXT) at the name, an MX record to the same server at another priority, a record identical to a declared one that another set's comment marks, or one identical to it that is proxied (a set's records are DNS only, and adopting it would turn its proxy off). Every page of a lookup is read, so a busy name hides nothing.

**Writes.** A create or an update is one batch (`POST /zones/{id}/dns_records/batch`), which Cloudflare runs as one transaction, all or nothing: a post for each declared record no record holds, a patch for each marked record of a declared one's type and name whose content, priority or ttl changed, or whose proxy was turned on by hand (one of the same content first, so a ttl's change patches that record), and each one adopted, and a delete for each marked record no longer declared. Each record is written unproxied (`proxied: false`), with a ttl of 1 (automatic) unless declared; a CAA record's content, `0 issue "letsencrypt.org"` (its value quoted or not), is sent as its fields and compared with its value quoted, as Cloudflare shows it. A set already as declared writes nothing, an update retried after its batch was written too. A delete is one batch deleting the marked records, and only those. A read gives each marked record as `records` holds it: its name in lower case with no trailing dot, a TXT record's text with the quotes Cloudflare may show around it taken off (and a long one's quoted parts joined), the priority of an MX record, the ttl (1 when automatic); a plan and drift compare a declared ttl left out as 1.

**Records not known yet.** Where `records` is taken from a domain apply creates in the same run, `plan` is given `records: null`: a set not bound yet plans a create, one the zone holds an update, with `records` among `unknown`, and apply plans it again at its step with the domain's records. An `update` whose `desired` leaves `records` out (the domain is absent or unreadable, so drift and apply leave the field out) keeps what the zone holds and writes nothing. `records: null` at a create or an update is refused, `not_known`: apply fails such a step before it gets there.

**The token.** The API token needs **Zone → DNS → Edit** on the zone, beside Zone Read (the zone's lookup) and the Workers permissions the container needs. A token without it is refused, not retryable, `no_dns_permission` (status 403), naming the permission and the zone, whether Cloudflare refuses the read of the records or the batch. A zone the account does not hold, or the token cannot read, is refused at a create, an update or a delete, `no_zone` (Cloudflare lists neither, so a delete is not taken as done with the records perhaps left behind); a read there finds the set gone.

## Driver

`@sanoma-ai/connector-cloudflare/driver` calls Cloudflare through its official SDK, [`cloudflare`](https://www.npmjs.com/package/cloudflare) (Stainless), with its own retries off (the runtime retries what is retryable), and calls the company's Worker with `fetch`. The `cloudflare` connector the package root exports carries it and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that).

`./driver` (`cloudflareDriver`; `cloudflareDriver({ timeoutMs, startTimeoutMs, pollMs })`: 30 s a request, ten minutes for the Worker to answer at a new revision, two seconds between tries; each request of the image's copy may take ten minutes) and `./fake` (`fakeCloudflare`) are internal entries, for tests.

A read is the Worker's settings (its bindings: what it runs is its plain-text bindings, never a secret's value), the application of its name (whether it exists, its id) and the account's subdomain (its URL); a plan compares the declared image, source, ref, revision, port, domains (left out too) and secret names with them. The requests are made one after another, in the order the fixtures hold.

### Environment

It reads these on every call, never when the config loads:

| Variable                | What it is                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | An API token with Workers Scripts Edit and Workers Containers Edit (Write, in the API's terms), Zone Read for `domains` (custom domains are attached and detached with Workers Scripts Edit) and DNS records, and Zone → DNS → Edit on the zones of [DNS records](#dns-records) |
| `CLOUDFLARE_ACCOUNT_ID` | The account's id, 32 hexadecimal digits, on its dashboard's overview                                                                                                                                                                                                            |

When either is unset, a call fails, not retryable, naming it. The driver declares both in its `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)): the worker starts without them, and the app's connector page shows their status and lets you set them. The alarm's operations need neither: they call the Worker with `SANOMA_WAKEUP_TOKEN` (`alarm.create` mints it when none is stored), and `alarm.create` stores `SANOMA_HOST_URL` once the host answered, for a register made off the host; it keeps the first one stored, which the Worker's own binding overrides on the host. A read without the token reads the alarm as unhealthy, so a plan to delete it still goes on.

### Errors and retries

A 429, a 5xx, a timeout or no reply is retryable, the image's copy's requests too; any other 4xx is not. `status` and `vendorCode` (Cloudflare's first error `code`) are kept. The driver's own refusals are not retryable: `exists` (a Worker of that name that is not Sanoma's, which is neither overwritten nor deleted), `plan_changed` (an update whose plan changed since it was approved, or is not an update: a new name is a delete and a create), `no_token` and `token` (a host without the company's `SANOMA_WAKEUP_TOKEN`, or with another one), `no_zone` (a domain or a record set whose zone the account does not hold), `conflict` (a record in the way of a declared one), `no_dns_permission` (a token without Zone → DNS → Edit), `not_known` (records given as `null`), `invalid` (a record the shared shape refuses, an MX one without a priority, one outside the zone, a CNAME or a second SPF policy beside another declared record, or a set's mark longer than 100 characters), and a Worker that did not answer at its revision in time, which says what it answered.

### Plan

Containers need the Workers Paid plan. An instance is billed while it runs, by its `standard-1` size, and not while it is stopped; the Worker and its object are billed per request.

### Testing the driver

`test/driver.test.ts`, `test/records.test.ts` and the features replay Cloudflare's replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api): `pnpm vitest run connectors/cloudflare` needs no account. The fixtures are **written from Cloudflare's API reference, not recorded**: no account was at hand when the connector was written. A recording replaces them (`SANOMA_LIVE=1 SANOMA_RECORD=1` on the features test), losing the account's id and subdomain, ids and tokens; until then, a reply the reference gets wrong is wrong here too. The upload's `containers` field (its `name`, `class_name` and `images`) is Wrangler's and not in the reference or the SDK's types, and the object's `ctx.container.images` and `start({ image, instance })` are the policy's: the live run is what checks them. The DNS records' fixtures (`records-*`) are written from the [DNS records reference](https://developers.cloudflare.com/api/resources/dns/subresources/records/) the same way, on `sanoma.work` with a set named `check` (`check-*.sanoma.work`), to be recorded on their first live run: Cloudflare's TXT content is quoted in them, which a read takes off. That Cloudflare shows a TXT record written unquoted with quotes is the reference's examples', not checked; a read compares it either way. The image's copy is tested against two small registries in this process (`test/registry.test.ts`), and the driver's call for its credentials over replies written from the SDK's types and the OCI distribution spec; that Cloudflare's registry takes the copy as written is what the live run checks. The driver tests only replay.

### Running it live

`test/live.ts`, run by hand, runs the Host and Wakeup kits against a real account, then prints how long a cold wake took (a request to a stopped container until it answers). It makes a Worker and a `durable_object` application named `sanoma-host-check` (`CLOUDFLARE_TEST_NAME` changes it), takes about an hour (each stop is Cloudflare's own ten quiet minutes), and deletes both at the end. It is what checks what the fixtures cannot: the copy and its pin by digest, the image's preparation, the upload's `containers[].images`, the application's body, the object's `start` with the `standard-1` instance type, and a deploy check's new image started by the object:

```sh
pnpm build
SANOMA_LIVE=1 CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  CLOUDFLARE_TEST_CHECKOUT=~/src/host-check-company CLOUDFLARE_TEST_DATABASE_URL=postgresql://... \
  CLOUDFLARE_TEST_SOURCE_KEY_FILE=~/.ssh/host-check-company_ed25519 \
  node connectors/cloudflare/test/live.ts
```

The kits have not run on a real account yet: the connector's first real run was Sanoma's own back office (`sanoma-ops`, 2026-10-29), deployed from the app's Resources page. What it showed: the second upload above, the Host the proxy forwards, and a cold start of about six to eight minutes on `standard-1` (the clone, `pnpm install` and `sanoma serve` of a company with a public site), which is what a visitor waits for after ten quiet minutes until the container is kept running or the sites move to the Worker.

It needs:

- a published runtime image, `ghcr.io/sanoma-ai/runtime:<version>` (the `sanoma` package's version), which apply copies into the account's registry; `CLOUDFLARE_TEST_IMAGE` names another;
- `CLOUDFLARE_TEST_CHECKOUT`: a clone of a company repository whose `origin` Cloudflare can clone and this machine can push to (each deploy check pushes an empty commit), holding the kits' company: [`connectors/docker/test/fixtures/company`](../docker/test/fixtures/company) with `sanoma` from npm, its config registering `wakeupCheckWorkflows` (the host checks' workflows and a tick every minute);
- `CLOUDFLARE_TEST_SOURCE_KEY_FILE`, for a private repository: the private half of a read-only deploy key on it, passed as the host's `SANOMA_SOURCE_KEY` secret as go-live does (the private `Sanoma-AI/host-check-company` is that company, with such a key);
- `CLOUDFLARE_TEST_DATABASE_URL`: a Postgres both the container and this machine reach, empty, the company's;
- Postgres here for the operator that applies the host (`pnpm db:up`).

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`cloudflareSteps`, attached with `withSetup`):

| Keyword | Step                                                       | What it does                                                                                                                 |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Given   | `a Cloudflare container for {string} at revision {string}` | Creates the company's container through `cloudflare.container.create`, its token generated, named `host` (`$host.state.url`) |

`features/cloudflare.feature` creates, reads, plans and deletes a container, and creates an alarm and registers with it, and `features/records.feature` creates a record set, reads it, plans it unchanged, updates it with a changed record and one dropped, and deletes it, on the fake and on the replies in `test/fixtures` (named after each scenario): `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). The package ships `features/`.

## Testing

`@sanoma-ai/connector-cloudflare/fake` is an in-memory Cloudflare account, the fake the connector carries: each sandbox run makes one of its own. Its registry is in memory too: a copy records the image under its reference there and pulls nothing. Its custom domains are in `state.domains` (hostname, Worker and zone), each zone's DNS records in `state.dns`, by the zone's name (a test adds one by hand there; a batch is all or nothing, and refuses a record identical to one the zone holds (its type, content and priority) or one beside a CNAME, as Cloudflare does), and it holds every zone asked for unless `fakeCloudflare({ zones })` names the ones it holds. A copy pins the image by a made-up digest, and a preparation answers ready for an image pinned in its registry. Its Workers answer on ports of this machine, one per Worker name, and run the package's own object code over a `ctx` in this process: storage in memory, an alarm on a timer (again after a throw), `ctx.container.images` from the upload's `containers[].images`, and a container that runs what `start` returns for the image (the one its pinned copy was copied from) and revision it was started at (by default a stub that answers `/healthz` and `/wake`); `start` refuses an image the upload did not name or an instance type that is not Cloudflare's. An upload restarts the object over its new bindings and images: a new image starts the container again at the next request, as the object finds its label changed.

```ts
import { fakeCloudflare } from "@sanoma-ai/connector-cloudflare/fake";
import { inProcessHost } from "@sanoma-ai/testing/host";

const fake = fakeCloudflare({
  start: ({ revision, env }) => inProcessHost(config, databaseUrl)({ port: 0, revision, secrets: env }),
});
// ...apply a container, then:
await fake.stop("acme"); // as ten quiet minutes would: the next request starts it
await fake.fire(); // rings every armed alarm now
fake.wakes(); // each /wake the containers answered
await fake.close();
```

`test/host.test.ts` and `test/wakeup.test.ts` run the Host and Wakeup kits over the fake this way, the company's runtime in this process; `test/worker.test.ts` runs the object's code over a stubbed `ctx`. Nothing here runs the Worker in `workerd`: [Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/) would, which this package does not add.

## Later

Snapshots, static egress, outbound Workers, and reading the logs (the Worker's and the container's are turned on at the upload and the application, and readable in the account's observability) are not done here yet.

License: FSL-1.1-ALv2.
