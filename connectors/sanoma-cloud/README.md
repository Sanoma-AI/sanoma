# @sanoma-ai/connector-sanoma-cloud

Sanoma Cloud for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): the company's database and host in Sanoma's own accounts, for a company with no database or hosting account of its own, declared in its repository like any other database and host. The driver is a client of sanoma-ops's `cloud-*` workflows over the public api of www.sanoma.work, with the company's Cloud token.

## Usage

```sh
npm install @sanoma-ai/connector-sanoma-cloud
```

```ts
// sanoma.config.ts
import { cloud } from "@sanoma-ai/connector-sanoma-cloud";

export default defineConfig({ connectors: [cloud /* , github, … */] });
```

A data file declares the database and the host; apply makes them at the Cloud:

```ts
// resources/sanoma/infra.ts
import { github } from "@sanoma-ai/connector-github/resources";
import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";

export const repo = github.repository({ owner: "acme", name: "acme-ops", visibility: "private" });
export const store = cloud.database({ region: "us-east" });
export const host = cloud.host({ name: "acme", database: store });
export default [repo, store, host];
```

The host says only its decisions, as `cloudflare.host` does: apply gives it the repository the app runs from (the declared `github.repository` that is its `origin`, else the one its data file declares, else `origin`'s URL) and that repository's default branch. There is no `secrets` block and no wakeup: the Cloud mints the instance's bootstrap (its database URL, keys and tokens) and binds it to the host itself, and the host wakes itself through its own Worker's alarm.

### The company's slug

One company is one slug, its address `<slug>.sanoma.work`, and both declarations are bound to it. The host's slug is its `name`, else `<slug>` of a `hostname` (or the deprecated `domains.app`) of `<slug>.sanoma.work`, else its repository's name (lower case, each run of other characters a dash); plan refuses one that is no slug the Cloud takes (`no_slug`: lower case letters, digits and dashes, a dash at neither end, one of them or 3 to 40). The database's is its `name`, else the one Cloud company the token holds: the one the wizard made, or the one the host makes, so a file whose token holds no company yet, or several (an account with a second company), declares `name` on the database, the same as the host's: an unnamed one is refused at plan (`no_slug`) until it is bound. Go live does not offer Sanoma Cloud yet (#514 G1): it leaves out the types of a vendor whose host binds its own bootstrap.

### `cloud.database`

| Field    | What it is                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `name`   | Optional: the company's slug (above). It cannot change.                                                                      |
| `region` | Optional: `us-east` (the Cloud's default), `us-west`, `eu-central`, `eu-west` or `ap-southeast` (`REGIONS`). It cannot move. |

Its state adds what the Cloud sets: `id` (the database's id there) and `healthy`. It meets the [`Database` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#databases): it pauses (a Neon compute in the Cloud's organization) and does not branch yet. Its `storeUrl` stores nothing and says so: the Cloud binds the URL to the host, and a laptop never needs it.

### `cloud.host`

| Field      | What it is                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | The company's slug (above).                                                                                                                                      |
| `hostname` | Optional: the company's address, `<slug>.sanoma.work` (the only one for now), which the Cloud takes as `domains.app`. Customers' own domains come later.         |
| `database` | Optional: the declared `cloud.database` it runs on. The Cloud binds its URL to the host itself.                                                                  |
| `source`   | Optional override of the derived repository: a clone URL, or a declared `github.repository`.                                                                     |
| `ref`      | Optional override of the derived branch. Apply resolves the branch to the commit it runs (`revision`, which a data file may not declare), so a merge deploys it. |
| `domains`  | Deprecated: declare `hostname`. The company's address as `app`.                                                                                                  |

Its state adds `revision`, `url` and `healthy`. It meets the [`Host` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#hosts) as a host that binds its own bootstrap (`bindsBootstrap`, so it takes no `secrets`): it stops when quiet and starts on the next request, its URL is public, it runs the Cloud's runtime image rather than building from git, and it has no fixed egress. A deploy moves it to another revision; another `source`, `ref`, `hostname`, `domains` or `name` plans a replace, which `update` refuses: delete it and declare it again.

| Operation                                     | Effect  | What it does                                                                                                                |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `cloud.database.read`, `.import`, `.plan`     | `read`  | Read the company's database from `cloud-list`; plan a change.                                                               |
| `cloud.database.create`, `.update`, `.delete` | `write` | Apply's: make it with `cloud-signup` (or bind the one the wizard made), refuse a new `region`, close it with `cloud-close`. |
| `cloud.database.storeUrl`                     | `read`  | Nothing: says the host binds the URL; apply calls it after a create.                                                        |
| `cloud.host.read`, `.import`, `.plan`         | `read`  | Read the company's host from `cloud-list`; plan a change.                                                                   |
| `cloud.host.create`, `.update`, `.delete`     | `write` | Apply's: make it with `cloud-signup`, move it to apply's revision with `cloud-deploy`, close it with `cloud-close`.         |

## Driver

`cloudDriver` starts sanoma-ops's workflows through `POST <SANOMA_CLOUD_URL>/api/call` (the app's plain-JSON form of a site's `api`): `<workflow>.start` with an id made from the call's idempotency key, so a retry resumes the same run, then `<workflow>.result` until the run ends (each request waits up to 20 s; `run_running` means wait again), with the token as `Authorization: Bearer`. A read starts `cloud-list { slug }`, and an empty list is a missing object; `create` starts `cloud-signup { slug, name, part, repository?, ref?, revision?, region?, domains? }`, `update` of the host `cloud-deploy { slug, revision }`, and `delete` `cloud-close { slug, part }` once `cloud-list` shows the part.

### Environment

| Variable             | What it is                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SANOMA_CLOUD_TOKEN` | The company's Cloud token, `sca_…`, shown once when the Sanoma account made it. The instance has it as a host secret, so it applies its own file. |
| `SANOMA_CLOUD_URL`   | Optional: where the api answers, `https://www.sanoma.work` unless set.                                                                            |

### Errors and retries

A run that fails fails the call with its failure, which the api answers with a 422 (`DriverError`, its status and `code` as `vendorCode`). Only no reply, a 408, a 429 and a 5xx are retryable (`retryableStatus`); a workflow's refusal (a slug someone else holds, a region the Cloud has not) and a refused token (401, said without its value) are final. A run that has not ended in 15 minutes (`runTimeoutMs`) fails retryable, and the retry resumes it. The driver's own refusals have a `vendorCode`: `no_slug`, `immutable`, `plan_changed`, `no_repository`, `gone`, `not_made`.

### Running it live

`test/live.ts` runs the operations against a real sanoma-ops by hand, never in CI: it makes a scratch company's database and host from a repository the token's account can use, waits for `/healthz`, checks a plan at the same revision is `none`, and closes both. With `SANOMA_CLOUD_TEST_DATABASE_URL`, the company database's URL read from sanoma-ops's store by hand, it runs the Database kit's run checks too (the suspend check stays the fake's). The Host kit's run checks need the same database and a stop the Cloud makes, so they run on the fake only for now.

```sh
pnpm build
SANOMA_LIVE=1 SANOMA_CLOUD_TOKEN=sca_... SANOMA_CLOUD_TEST_REPOSITORY=Sanoma-AI/host-check-company \
  node connectors/sanoma-cloud/test/live.ts
```

`SANOMA_CLOUD_URL`, `SANOMA_CLOUD_TEST_SLUG` (default `host-check`), `SANOMA_CLOUD_TEST_REF` (`main`) and `SANOMA_CLOUD_TEST_REGION` (`us-east`) are optional.

## The fake

`fakeCloud()` is an in-memory Cloud: the token's companies by slug, each with the parts `cloud-signup` made, all healthy; a host runs `start`'s runtime (a stub answering `/healthz` and `/wake` by default) behind an address in this process that outlives it, starts it on a request, and moves it on a deploy; `cloud-close` removes a part, and the company with its last. `stop(slug)` stops a host's runtime as a quiet spell would. It refuses what the workflows refuse.

## Testing

`pnpm vitest run connectors/sanoma-cloud`, with Postgres from `pnpm db:up`: the driver against a stand-in for the api, and the Host and Database kits over the fake.

## Logo

`logo.svg` is a plain cloud drawn for this package: Sanoma has no published mark yet.
