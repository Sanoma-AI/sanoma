# @sanoma-ai/connector-sanoma-ops

The hosted wakeup on sanoma-ops, a resource that meets the [`Wakeup` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#hosts), for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows). A worker whose data files declare a wakeup stops itself when nothing it would run can run soon, after it registers its next deadline here; the wakeup service then calls the host's `GET {url}/wake?generation=N` at that time. The service is [`sanoma wakeup`](https://www.npmjs.com/package/sanoma), which sanoma-ops runs for its customers and a self-hoster can run on any machine that stays up.

## Usage

```sh
npm install @sanoma-ai/connector-sanoma-ops
```

Declare the wakeup in a data file, for the host it wakes. Declaring it is the whole switch: without it the worker stays up and fires its own deadlines.

```ts
// resources/infra.ts
import { sanomaOps } from "@sanoma-ai/connector-sanoma-ops/resources";

export const host = /* the host's declaration */;
export const wakeup = sanomaOps.wakeup({ host });
```

| Operation                   | Effect  | What it does                                                                                                |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `sanomaOps.wakeup.read`     | `read`  | Read an instance of the wakeup service: its host's URL, the wake it holds and the last call's error.        |
| `sanomaOps.wakeup.import`   | `read`  | Find an instance by its id.                                                                                 |
| `sanomaOps.wakeup.plan`     | `read`  | Plan what apply would do: create an instance, nothing, or replace it for a new host.                        |
| `sanomaOps.wakeup.create`   | `write` | Create an instance for the host and store its token as `SANOMA_WAKEUP_TOKEN`. Only apply calls it.          |
| `sanomaOps.wakeup.update`   | `write` | Replace the instance for a new host. Only apply calls it.                                                   |
| `sanomaOps.wakeup.delete`   | `write` | Delete the instance; done already when it is gone. Only apply calls it.                                     |
| `sanomaOps.wakeup.register` | `write` | Ask the service to call the host's `/wake` at `at` with `generation`, replacing the wake registered before. |

`register` takes `{ id, at, generation }`: the instance's id (the wakeup's binding), an ISO 8601 time and a generation from 1. The worker calls it before it stops, with each new generation; the service applies one only when it is newer, so a retry, or a late duplicate, changes nothing. No workflow calls these operations: apply calls the resource's, and the worker calls `register`.

The wakeup has no identity: the service names each instance, and the lockfile binds the declaration to its id. Its `host` holds the URL the service calls; a new one is a new instance. Its state is `{ id, host, at, generation, lastError }`, and it is `healthy` while it exists and the last call to the host's `/wake` did not fail.

The logo the app shows beside these operations is Sanoma's own mark, the shield of [Phosphor Icons](https://phosphoricons.com) (MIT) that the app uses as its icon.

## Driver

`@sanoma-ai/connector-sanoma-ops/driver` calls the wakeup service. The `sanomaOps` connector the package root exports carries it, made once per resolved config, its fake and its steps (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone:

```ts
import { sanomaOps } from "@sanoma-ai/connector-sanoma-ops";

export default defineConfig({ workflows, connectors: [sanomaOps /* , the host's connector */] });
```

`./driver` (`sanomaOpsDriver`; `sanomaOpsDriver({ timeoutMs })`, 10 s by default) and `./fake` (`fakeSanomaOps`) are internal entries, for tests.

The service has no SDK or OpenAPI spec, so the driver is plain `fetch` over its routes: `POST /wakeup/instances { url }` (201 `{ id, token }`), `GET` and `DELETE /wakeup/instances/{id}`, each with the account's token, and `PUT /wakeup/instances/{id}/wake { at, generation }` with the instance's own. A redirect is refused, so a token never follows one.

### Environment

It reads these on every call, never when the config loads:

| Variable              | What it is                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANOMA_OPS_URL`      | Optional: the wakeup service's URL, such as a self-hoster's `sanoma wakeup`. Unset, Sanoma's hosted service: `https://sanoma.ai` for now, a placeholder (`HOSTED_URL` in `src/driver.ts`) until sanoma-ops serves the service at its own URL. |
| `SANOMA_OPS_TOKEN`    | An account's token at the service (`swa_…`), which apply creates, reads and deletes instances with. `sanoma wakeup account <label>` mints one.                                                                                                |
| `SANOMA_WAKEUP_TOKEN` | This instance's token (`swi_…`), which `register` sends. Never set by hand: `create` stores it (below).                                                                                                                                       |

The service shows an instance's token once, in its reply to `POST /wakeup/instances`, so `create` stores it in the company's secrets store (the credentials table) as `SANOMA_WAKEUP_TOKEN`, never in its output, the ledger or a checkpoint; the worker loads it from there, and a host's `secrets` may name it (`secret("SANOMA_WAKEUP_TOKEN")`). The store keeps the first value it is given, so a create that finds another instance's token stored deletes the instance it just made and fails, not retryable (`vendorCode` `stale`), and an update to a new host fails the same way before it changes anything: clear `SANOMA_WAKEUP_TOKEN` on the connector page, then apply again (a delete leaves the token stored too, as the store cannot remove a value). With the token cleared, an update creates the new instance first and deletes the old one after, so a create that fails leaves the old one in place. Each variable is declared in the driver's `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)), all optional, since an instance that only registers needs no account's token: an operation that needs one that is unset fails, not retryable, naming it.

### Errors and retries

A 408, a 429, a 5xx, a timeout (10 s; `timeoutMs` changes it) or no reply is retryable; any other 4xx is not (a 401 for a token the service does not know, a 403 for another account's or instance's, a 400 for a bad URL or registration). `status` is kept, and the message is the service's `error`. A 404 is an instance that is gone only when it is the service's own (its JSON `{ error }`); another server's 404 at `SANOMA_OPS_URL` is a failure. The service has no error codes, so `vendorCode` is set only for the driver's own refusals: `stale` and `plan_changed` (an `update` whose fresh plan differs from the one apply approved).

### Testing the driver

`test/driver.test.ts` and the features replay the service's recorded replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api): `pnpm vitest run connectors/sanoma-ops` needs no account. The fixtures were recorded against a local `sanoma wakeup`: serve one (`sanoma wakeup`, or `serveWakeup` in `test/service.ts`), mint an account, and run the features live:

```sh
SANOMA_LIVE=1 SANOMA_RECORD=1 SANOMA_OPS_URL=http://127.0.0.1:<port> SANOMA_OPS_TOKEN=swa_... pnpm vitest run connectors/sanoma-ops/test/features.test.ts -t driver
```

A recording loses the instances' ids and tokens (`scrub` in `test/replay.ts`). `test/wakeup.test.ts` runs the Wakeup contract's conformance kit (`checkWakeup` from `@sanoma-ai/testing/wakeup`) against the fake and against the real service, started in the test's process on a database of its own, each waking a host that stops (`fakeHost` with `stops-on-exit`); it needs Postgres (`pnpm db:up`).

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`sanomaOpsSteps`, attached with `withSetup`):

| Keyword | Step                                                    | What it does                                                                                           |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Given   | `a sanoma-ops wakeup for {string}`                      | Creates an instance for that host URL through `sanomaOps.wakeup.create`, named `wakeup` (`$wakeup.id`) |
| Then    | `a sanoma-ops wake is registered with generation {int}` | The run registered a wake with that generation through `sanomaOps.wakeup.register`                     |

`features/wakeup.feature` creates, reads, plans, registers with and deletes instances, with these steps and the generic ones for an operation's own test, on the fake and on the recorded replies: `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). The package ships `features/`.

## Testing

`@sanoma-ai/connector-sanoma-ops/fake` is an in-memory wakeup service, the fake the connector carries: each sandbox run makes one of its own. It answers as the service does (UUID-shaped ids made in order, a `swi_…` token for each, stored as the call's `SANOMA_WAKEUP_TOKEN`; a register only with the instance's own token, and only a newer generation), then sends `GET {host}/wake?generation=N` at `at`, again every 250 ms until the host answers 2xx. `fake.fire()` sends every armed wake now; `fake.close()` (and `fake.reset()`) disarms them. `state.instances` holds the instances by id, and `calls` every call; `failNext`, `loseReply`, `rateLimit` and `hold` set up the next call to an operation, as for any fake from `defineFake`.

License: FSL-1.1-ALv2.
