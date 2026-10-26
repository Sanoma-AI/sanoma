# @sanoma-ai/connector-cloudflare

[Cloudflare Containers](https://developers.cloudflare.com/containers/) as a host that stops when quiet, and its [Durable Object](https://developers.cloudflare.com/durable-objects/)'s [alarm](https://developers.cloudflare.com/durable-objects/api/alarms/) as the wakeup that starts it again, for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows). Both are one Worker per company, `sanoma-<name>`, on the account's workers.dev subdomain.

## Usage

```sh
npm install @sanoma-ai/connector-cloudflare
```

Both types are writable: `read` and `import` (effect `read`), and the change operations only the apply workflow may call, `plan` (effect `read`), `create`, `update` and `delete` (effect `write`). The container is a host ([Hosts](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#hosts)) and the alarm a wakeup, with one more operation, `register`, which the worker calls:

| Type        | Operations                                                                                | Import id      |
| ----------- | ----------------------------------------------------------------------------------------- | -------------- |
| `container` | `cloudflare.container.read`, `.import`, `.plan`, `.create`, `.update`, `.delete`          | its name       |
| `alarm`     | `cloudflare.alarm.read`, `.import`, `.plan`, `.create`, `.update`, `.delete`, `.register` | its host's URL |

A data file declares them with the constructors in `@sanoma-ai/connector-cloudflare/resources`. Declaring the alarm is the whole switch for scaling to zero: without it, nothing starts a stopped container at a deadline, and a sleeping run waits for the next request.

```ts
// resources/infra.ts
import { cloudflare } from "@sanoma-ai/connector-cloudflare/resources";
import { secret } from "sanoma/resources";

export const host = cloudflare.container({
  name: "acme", // the Worker sanoma-acme, at https://sanoma-acme.<subdomain>.workers.dev
  image: "docker.io/sanomaai/runtime:0.7.0",
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

| Field                  | What it is                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | The company's name, its identity: lowercase letters, digits and dashes, up to 56; the Worker and its application are `sanoma-<name>`    |
| `image`                | The Sanoma runtime image, pinned to a tag or digest, never `latest`; a registry Cloudflare pulls from (Docker Hub, or Cloudflare's own) |
| `source`               | The company repository: a clone URL, or a declared `github.repository`                                                                  |
| `ref`                  | The branch it runs, never a commit: apply resolves it and sets the hidden `revision`, so a merge is drift on the container              |
| `port`                 | The port the runtime listens on in the container (its `PORT`)                                                                           |
| `secrets`              | Environment variables, each a `secret(...)`: the Worker's secret bindings, write-only, never in an output, the ledger or a checkpoint   |
| `domains`              | Optional: a public site's domain, by site name, passed as `SANOMA_DOMAINS`; routing a domain to the Worker is not done here yet         |
| `id`, `url`, `healthy` | Cloudflare's: the application's id, the Worker's workers.dev URL, and whether it answers                                                |

The host's outputs are `{ url, revision, healthy }`. Its capabilities: stops when quiet, a public URL, it runs an image rather than building one, no fixed egress. `healthy` is the application existing and the Worker answering `/__sanoma/health`, which does not start a stopped container: a stopped host is healthy, and a read or a drift check leaves it stopped.

The alarm's only field is `host`, the container it wakes (its URL); its state is `{ host, at, generation, rang, healthy }`, the wake it holds, when its alarm last rang the host's `/wake` for it, and whether the host's Worker took the company's token. `register` takes `{ at, generation }`, an ISO 8601 time and a generation from 1, and the Worker keeps it only when it is newer, so a retry or a late duplicate changes nothing. It names no host: on the host, the worker reads the host's URL from `SANOMA_HOST_URL`, which the Worker gives the container; off it, from the credential `alarm.create` stored.

The logo is Cloudflare's cloud from [Simple Icons](https://simpleicons.org/?q=cloudflare) (CC0), there only to identify the service an operation calls.

## The Worker

The package ships the Worker it uploads, `worker/`: `index.js`, which exports the Durable Object class `SanomaInstance` over `DurableObject` from `cloudflare:workers`, and `instance.js`, the object's code with no imports (typed by `instance.d.ts`), which the fake runs in Node so both kits check the code Cloudflare runs. Every request to the Worker goes to its one object, which:

- starts the container on a request at the revision and image the Worker's `SANOMA_REVISION` and `SANOMA_IMAGE` name, with the Worker's text bindings (plain and secret) as its environment and both as labels (the image's as a digest, since a label holds 64 bytes); a running container that does not carry both is destroyed and started again (a deploy);
- waits for the container's `/healthz` (up to ten minutes, the clone and install included), sets its inactivity timeout to ten minutes, and proxies the request to its `port`;
- answers `GET /__sanoma/health` with `{ revision, running }` without starting the container, and with `?start=1` once the container answers, which is what a create or update waits for;
- holds the company's one wake at `/__sanoma/wake`, with `Authorization: Bearer <SANOMA_WAKEUP_TOKEN>`: `GET` shows `{ at, generation, rang? }`, `PUT { at, generation }` sets the object's alarm when the generation is newer, `DELETE` clears it. Without the token among the host's secrets it answers 404, with another one 401;
- at the alarm, starts the container and calls its `/wake?generation=N`, then notes when (`rang`); a failure throws, so Cloudflare rings the alarm again.

Cloudflare stops the container after ten quiet minutes; the object, its storage and its alarm stay, and the next request or alarm starts the container again. A create uploads the Worker with the object's migration (`new_sqlite_classes`) and its class as a container's (`containers: [{ class_name }]`, as Wrangler sends it), turns its workers.dev URL on, and makes the container application for the object's namespace (the `namespace_id` the Worker's settings then show; `basic`, one instance at most, none until a request); an update uploads it again and, for a new image, rolls the application out to it (`rolling`, all at once). Either waits for the Worker to answer at the new revision. A delete deletes the application, then the Worker with its object's storage. A Worker of that name that is not Sanoma's (no `SANOMA_INSTANCE` binding) reads as gone, and a create or a delete refuses to touch it.

## Scale to zero

1. **The connector.** Add `cloudflare` to the connectors in `sanoma.config.ts`: the worker on the host calls `cloudflare.alarm.register` through it.
2. **Credentials.** On the connector's page, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (below).
3. **Go live.** `infra.ts` declares the host with `SANOMA_WAKEUP_TOKEN: secret("SANOMA_WAKEUP_TOKEN", { generate: true })` among its secrets (apply makes it), and, after it, `export const wakeup = cloudflare.alarm({ host })`. One apply makes the Worker, waits for it, then the alarm, which checks the Worker holds the token.
4. **A sleeping run.** Start a workflow that sleeps past ten quiet minutes. Before the container stops the worker registers the sleep's end; at `at` the object's alarm starts the container and calls `/wake`, and the run continues.

To stop scaling to zero, delete the `wakeup` line and apply: the alarm is deleted, and the next request still starts the container.

## Driver

`@sanoma-ai/connector-cloudflare/driver` calls Cloudflare through its official SDK, [`cloudflare`](https://www.npmjs.com/package/cloudflare) (Stainless), with its own retries off (the runtime retries what is retryable), and calls the company's Worker with `fetch`. The `cloudflare` connector the package root exports carries it and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that).

`./driver` (`cloudflareDriver`; `cloudflareDriver({ timeoutMs, startTimeoutMs, pollMs })`: 30 s a request, ten minutes for the Worker to answer at a new revision, two seconds between tries) and `./fake` (`fakeCloudflare`) are internal entries, for tests.

A read is the Worker's settings (its bindings: what it runs is its plain-text bindings, never a secret's value), the application of its name (its image) and the account's subdomain (its URL); a plan compares the declared image, source, ref, revision, port, domains (left out too) and secret names with them. The requests are made one after another, in the order the fixtures hold.

### Environment

It reads these on every call, never when the config loads:

| Variable                | What it is                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | An API token with Workers Scripts Edit and Workers Containers Edit (Write, in the API's terms) |
| `CLOUDFLARE_ACCOUNT_ID` | The account's id, 32 hexadecimal digits, on its dashboard's overview                           |

When either is unset, a call fails, not retryable, naming it. The driver declares both in its `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)): the worker starts without them, and the app's connector page shows their status and lets you set them. The alarm's operations need neither: they call the Worker with `SANOMA_WAKEUP_TOKEN` (`alarm.create` mints it when none is stored), and `alarm.create` stores `SANOMA_HOST_URL` once the host answered, for a register made off the host; it keeps the first one stored, which the Worker's own binding overrides on the host. A read without the token reads the alarm as unhealthy, so a plan to delete it still goes on.

### Errors and retries

A 429, a 5xx, a timeout or no reply is retryable; any other 4xx is not. `status` and `vendorCode` (Cloudflare's first error `code`) are kept. The driver's own refusals are not retryable: `exists` (a Worker of that name that is not Sanoma's, which is neither overwritten nor deleted), `plan_changed` (an update whose plan changed since it was approved), `no_token` and `token` (a host without the company's `SANOMA_WAKEUP_TOKEN`, or with another one), and a Worker that did not answer at its revision in time, which says what it answered.

### Plan

Containers need the Workers Paid plan. An instance is billed while it runs, by its `basic` size, and not while it is stopped; the Worker and its object are billed per request.

### Testing the driver

`test/driver.test.ts` and the features replay Cloudflare's replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api): `pnpm vitest run connectors/cloudflare` needs no account. The fixtures are **written from Cloudflare's API reference, not recorded**: no account was at hand when the connector was written. A recording replaces them (`SANOMA_LIVE=1 SANOMA_RECORD=1` on the features test), losing the account's id and subdomain, ids and tokens; until then, a reply the reference gets wrong is wrong here too. The upload's `containers` field is Wrangler's and not in the reference or the SDK's types: the live run is what checks it. The driver tests only replay.

### Running it live

`test/live.ts`, run by hand, runs the Host and Wakeup kits against a real account, then prints how long a cold wake took (a request to a stopped container until it answers). It makes a Worker and an application named `sanoma-host-check` (`CLOUDFLARE_TEST_NAME` changes it), takes about an hour (each stop is Cloudflare's own ten quiet minutes), and deletes both at the end:

```sh
pnpm build
SANOMA_LIVE=1 CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  CLOUDFLARE_TEST_CHECKOUT=~/src/host-check-company CLOUDFLARE_TEST_DATABASE_URL=postgresql://... \
  node connectors/cloudflare/test/live.ts
```

It needs:

- a published runtime image Cloudflare can pull, `docker.io/sanomaai/runtime:<version>` (the `sanoma` package's version; `CLOUDFLARE_TEST_IMAGE` names another);
- `CLOUDFLARE_TEST_CHECKOUT`: a clone of a company repository whose `origin` Cloudflare can clone and this machine can push to (each deploy check pushes an empty commit), holding the kits' company: [`connectors/docker/test/fixtures/company`](../docker/test/fixtures/company) with `sanoma` from npm, its config registering `wakeupCheckWorkflows` (the host checks' workflows and a tick every minute);
- `CLOUDFLARE_TEST_DATABASE_URL`: a Postgres both the container and this machine reach, empty, the company's;
- Postgres here for the operator that applies the host (`pnpm db:up`).

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`cloudflareSteps`, attached with `withSetup`):

| Keyword | Step                                                       | What it does                                                                                                                 |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Given   | `a Cloudflare container for {string} at revision {string}` | Creates the company's container through `cloudflare.container.create`, its token generated, named `host` (`$host.state.url`) |
| Then    | `a Cloudflare wake is registered with generation {int}`    | The run registered a wake with that generation                                                                               |

`features/cloudflare.feature` creates, reads, plans and deletes a container, and creates an alarm and registers with it, on the fake and on the replies in `test/fixtures` (named after each scenario): `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). The package ships `features/`.

## Testing

`@sanoma-ai/connector-cloudflare/fake` is an in-memory Cloudflare account, the fake the connector carries: each sandbox run makes one of its own. Its Workers answer on ports of this machine, one per Worker name, and run the package's own object code over a `ctx` in this process: storage in memory, an alarm on a timer (again after a throw), and a container that runs what `start` returns for the image and revision it was started at (by default a stub that answers `/healthz` and `/wake`). An upload restarts the object over its new bindings; a rollout stops the container, as Cloudflare replaces it.

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

Custom domains (routing `domains` to the Worker), the `durable_object` scheduling policy and snapshots, static egress, outbound Workers, and observability (the Worker's and the container's logs) are not done here yet.

License: FSL-1.1-ALv2.
