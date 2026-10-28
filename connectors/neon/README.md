# @sanoma-ai/connector-neon

[Neon](https://neon.com) serverless Postgres for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): a project as the company's database, which pauses when idle and branches for previews, through Neon's own SDK, [`@neondatabase/api-client`](https://www.npmjs.com/package/@neondatabase/api-client).

## Usage

```sh
npm install @sanoma-ai/connector-neon
```

A data file declares the project; apply creates it, waits for its compute, and stores its URL:

```ts
// resources/sanoma/infra.ts
import { neon } from "@sanoma-ai/connector-neon/resources";

export const store = neon.project({ name: "acme-ops", region: "aws-us-east-1" });
```

| Field        | What it is                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`       | The project's name. Neon names projects by an id it makes, so two may share a name: the lockfile binds the declaration to the id.                                                                                                                                                                                                                      |
| `region`     | A Neon region id: `aws-us-east-1`, `aws-us-east-2`, `aws-us-west-2`, `aws-eu-central-1`, `aws-eu-west-2`, `aws-ap-southeast-1`, `aws-ap-southeast-2` or `aws-sa-east-1` (`REGIONS`). A project cannot move.                                                                                                                                            |
| `size`       | Optional: the compute's size in compute units, such as `0.25` (the default) or `1`, which sets both of Neon's autoscaling limits, or `min-max` (`0.25-2`) to autoscale between them: 0.25 or more, a minimum no more than its maximum. It changes in place, and compares as Neon reads it back (`0.50` is `0.5`). Left out, the size stays what it is. |
| `pg_version` | Optional: the major Postgres version, Neon's default when unset. A project cannot change it.                                                                                                                                                                                                                                                           |

Its state adds what Neon sets: `id`, `host` (the default compute's), `default_branch_id`, `default_endpoint_id` and `healthy` (the default compute has started: `active`, or `idle` while paused).

The project type meets the [`Database` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#databases) (`database`): it pauses (its compute suspends after five minutes without queries and wakes on the next connection) and branches (a copy-on-write branch carries the data), takes `region` from `REGIONS` and `size`, and stores its URL with `project.storeUrl`. Going live chooses it before any other database type.

| Operation                                      | Effect  | What it does                                                                                                                                                   |
| ---------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neon.project.read`, `.import`, `.plan`        | `read`  | Read a project, its default branch and that branch's read-write compute; plan a change.                                                                        |
| `neon.project.create`, `.update`, `.delete`    | `write` | Apply's: create a project, rename or resize it, delete it. A new `region` or `pg_version` plans a replace, which `update` refuses: the data would stay behind. |
| `neon.project.health`                          | `read`  | Whether the default compute has started; apply calls it after a create until it has.                                                                           |
| `neon.project.storeUrl`                        | `write` | Store the project's direct URL as `SANOMA_DATABASE_URL_<EXPORT>`, never returned; apply calls it after a create.                                               |
| `neon.branch.create`                           | `write` | Branch a project's default branch, with its data and a read-write compute; returns `{ id, url }`.                                                              |
| `neon.branch.delete`                           | `write` | Delete a branch and its computes; done when it is gone.                                                                                                        |
| `neon.endpoint.suspend`, `neon.endpoint.start` | `write` | Suspend a compute now, dropping its connections, or start it; return the state it goes to.                                                                     |

`project.storeUrl` stores the direct (unpooled) URI of the project's database `neondb` and role `neondb_owner` (`GET /projects/{id}/connection_uri?pooled=false`), which carries `LISTEN`, as DBOS needs; Neon's pooler runs in transaction mode, which does not. The secret only adds: one that holds another URL (another project, or a password reset) is refused (`stale`), so delete it to store the new one. `branch.create` returns the branch's direct URL with the role's password this once, as Neon does: keep it in a secret, not in a run's output. The ledger records it as `"<url>"` (`opaque`).

The logo the app shows beside these operations is Neon's logomark from its [brand page](https://neon.com/brand), in color for light and dark backgrounds. It is there only to identify the service an operation calls.

## Driver

`@sanoma-ai/connector-neon/driver` calls Neon. The `neon` connector the package root exports carries it, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone:

```ts
import { neon } from "@sanoma-ai/connector-neon";

export default defineConfig({ workflows, connectors: [neon], policy });
```

`./driver` (`neonDriver`; `neonDriver({ timeoutMs })`, 30 s by default) and `./fake` (`fakeNeon`) are internal entries, for tests. The SDK (and axios with it) loads at the first call, so a worker that never calls Neon does not load it.

### Environment

It reads this on every call, never when the config loads:

| Variable       | What it is                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `NEON_API_KEY` | An organization API key, from console.neon.tech, Organization settings, API keys. `/setup` asks for it. |

When it is unset, a call fails, not retryable, naming it, before any request. The driver declares it in its `env` ([Credentials](https://www.npmjs.com/package/@sanoma-ai/workflows#credentials)).

### Errors and retries

Every failure is a `DriverError` keeping Neon's `status` and its error `code` as `vendorCode`. A 408, a 423 (the project's earlier operations, such as a new compute's start, still run), a 429, a 5xx, a timeout or no reply is retryable; any other 4xx is not. A 404 with Neon's error body reads a project as gone, and deletes a project or branch as done; one without it fails. An error never carries axios's, whose request headers hold the key.

### Testing the driver

`test/driver.test.ts` and the features replay Neon's replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api): `pnpm vitest run connectors/neon` needs no account. The features' fixtures are recorded from a real organization (2026-10-27); the driver tests' own are written by hand from Neon's API reference (the OpenAPI spec the SDK bundles, `public-v2-for-users.gen.yaml`) and checked against those recordings. Record the features again with an organization's key, which creates projects there and deletes them after each scenario:

```sh
SANOMA_LIVE=1 SANOMA_RECORD=1 NEON_API_KEY=napi_... pnpm vitest run connectors/neon/test/features.test.ts
```

A recording loses passwords, request ids and the organization (its id, name and email). The error cases only replay. Right after a create, Neon's compute is `init` and a branch or a suspend of the project answers 423 until it has started (a few seconds): a scenario's `Given` project is seeded as apply makes it, its `afterCreate` polled, so its compute has started.

### Running it live

`test/live.ts`, run by hand, runs the Database kit (`checkDatabase`) against a real project with the real driver, then times a suspended compute's wake, and deletes the project at the end. It makes a project named `database-check` (`NEON_TEST_NAME` changes it, `NEON_TEST_REGION` its region, `aws-us-east-1` by default) in the key's organization, whose plan's limits apply:

```sh
pnpm build
SANOMA_LIVE=1 NEON_API_KEY=napi_... node connectors/neon/test/live.ts
```

Measured 2026-10-27 on a Free organization, `aws-us-east-1`, Postgres 18, a 0.25 CU compute: the create answers in 0.4 s and its compute is `active` 5 to 12 s later (the `init` apply's `afterCreate` polls through); a suspend reads `idle` 2.5 s after the request, and the first query after it, a worker's connect included, answers in 1.8 s. Every check of the kit passed.

## Steps and features

The connector carries steps for [scenarios](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#steps-a-connector-ships) (`neonSteps`, attached with `withSetup`):

| Keyword | Step                                  | What it does                                                                   |
| ------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Given   | `a Neon project {string} in {string}` | Creates a project of that name in that region, named `project` (`$project.id`) |
| Then    | `a Neon branch {string} was created`  | The run created a branch of that name                                          |

`features/project.feature` creates, reads, waits for, plans and deletes a project, and `features/branch.feature` branches one and suspends its compute, on the fake and on the replies named after each scenario: `test/features.test.ts` runs them with [`describeFeatures`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-connectors-own-features). The package ships `features/`.

## Testing

`@sanoma-ai/connector-neon/fake` is an in-memory Neon, the fake the connector carries: projects in `state.projects`, each with a default branch `main` and its read-write compute, active at once, ids made in order (`fake-project-1`, `br-fake-2`, `ep-fake-3`). A suspend makes a compute `idle` and a start `active`. It refuses what Neon refuses: a region not in `REGIONS` (404, as Neon answers), an object it does not have (404), a project's default branch deleted. `test/database.test.ts` runs the `Database` contract's kit (`@sanoma-ai/testing/database`) over it, with a database of the test Postgres standing in for the project's.

License: FSL-1.1-ALv2.
