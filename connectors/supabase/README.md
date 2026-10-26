# @sanoma-ai/connector-supabase

Supabase projects for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows), read through the [`supabase/supabase`](https://github.com/supabase/terraform-provider-supabase) OpenTofu provider (1.11.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge), which apply creates, changes and deletes, and the session pooler, health and database URL of a project from Supabase's [Management API](https://api.supabase.com/api/v1).

## Usage

```sh
npm install @sanoma-ai/connector-supabase
```

The one resource type is writable: `read` and `import` (effect `read`), and the change operations only the apply workflow may call, `plan` (effect `read`), `create`, `update` and `delete` (effect `write`), with the project's ref as the policy's `target` (`new:supabase.project` for a create):

| Type      | Operations                                                                   | Import id               |
| --------- | ---------------------------------------------------------------------------- | ----------------------- |
| `project` | `supabase.project.read`, `.import`, `.plan`, `.create`, `.update`, `.delete` | `id`, the project's ref |

`import` takes `{ id }` and returns the project's `state`; `read` takes a state an earlier call returned, or just `{ id }`, and returns its fresh `state`, or `gone: true`. The change operations are [Resources](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#resources)' contract, through the provider's plan and apply. `create` first lists the projects the token can see and refuses (a `DriverError`, `vendorCode` `exists`, not retryable) when the organization has one of the declared name already: a create retried after Supabase made the project, but before the run recorded it, stops there rather than making a second project, and the error names the project's ref to bind. The provider waits for a new project to be `ACTIVE_HEALTHY` (five minutes at most).

Three more operations call the Management API, each with the project's ref as `target`:

| Operation                    | Effect  | Input                | Output                                               |
| ---------------------------- | ------- | -------------------- | ---------------------------------------------------- |
| `supabase.pooler.get`        | `read`  | `{ ref }`            | `{ host, port: 5432, user, database }`               |
| `supabase.project.health`    | `read`  | `{ ref, services? }` | `{ healthy, services: [{ name, healthy, status }] }` |
| `supabase.database.storeUrl` | `write` | `{ ref, export }`    | `{ secret }`                                         |

`pooler.get` reads the primary database's entry of `GET /v1/projects/{ref}/config/database/pooler`. The provider's project has no host, and the pooler's (`aws-<n>-<region>.pooler.supabase.com`) is not derivable from the region, so it is read per project. The port is always 5432, the session pooler's: DBOS needs `LISTEN`/`NOTIFY`, which the transaction pooler (6543) does not carry, and the direct address is IPv6 only. `project.health` reads `GET /v1/projects/{ref}/health` for `services` (default `["db", "pooler"]`), healthy when every one is.

`database.storeUrl` builds `postgresql://<user>:<password>@<host>:5432/<database>?sslmode=require` from `pooler.get` and the stored secret `SUPABASE_DB_PASSWORD`, and stores it with the secrets store's `ensure` as `SANOMA_DATABASE_URL_<EXPORT>`, `<EXPORT>` the data file's export in upper snake case (`store` → `SANOMA_DATABASE_URL_STORE`). It returns the secret's name only: the URL is never in an output, the ledger or a log. The store only adds secrets, so when the secret holds another URL (the project was replaced, or its password or pooler changed), `storeUrl` fails (`vendorCode` `stale`), naming it: delete the secret, then store it again. A project being deleted (`GOING_DOWN`, `REMOVED`) does not stop a create of its name.

Apply calls two of them after it creates a project (the type's `afterCreate`): `project.health` until the database and pooler are healthy, then `database.storeUrl` with the data file's export, so a host can name the URL as `secret("SANOMA_DATABASE_URL_STORE")`.

The project type meets the [`Database` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#databases) (`database`): it neither pauses nor branches (a paid project never pauses, and a branch starts empty), takes `region` from Supabase's regions (`database.regions`), and stores its URL with `database.storeUrl`. Going live chooses it when the config has no Neon project type.

A data file declares a project with the constructor in `@sanoma-ai/connector-supabase/resources`, without its ref, which Supabase sets: which project a declaration means is its binding, in the [lockfile](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#bindings), by its ref. A declaration with no binding is `absent` to a drift check.

```ts
import { supabase } from "@sanoma-ai/connector-supabase/resources";
import { secret } from "sanoma/resources";

export const store = supabase.project({
  name: "acme-ops",
  organization_id: "acme",
  region: "us-east-1",
  database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
});
```

The fields are the provider's attributes, by their names: `organization_id` is the organization's slug. `secret("SUPABASE_DB_PASSWORD", { generate: true })` has apply generate the password and store it before the create; it is the name `database.storeUrl` reads. Only declared fields are compared for drift. The provider reads `instance_size` back only for a project with a compute add-on (`null` otherwise) and never reads `timeouts`, so declare neither unless that holds. The project's host, pooler and health are not attributes of the provider's project, so they are not here.

The logo is Supabase's bolt from [Simple Icons](https://simpleicons.org/?q=supabase) (CC0), there only to identify the service an operation calls.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate`, which runs [`@sanoma-ai/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/src/tfschema/AGENTS.md) with `src/resources.config.ts`: the provider (its release, sha256 and recorded schema are `@sanoma-ai/bridge`'s pin and fixture), the type, and the attributes whose change replaces the project (`organization_id` and `region`, which the provider's update refuses). It is checked in and never edited by hand; `pnpm generate` on a clean tree changes nothing. `src/connector.ts` is the rest, one `tfConnector` record from [`@sanoma-ai/bridge/connector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers): the type's title (no identity: a project is found by its binding, its ref), when a state is no project, and Supabase's title and logo. The ref (`id`) is vendor-owned and a data file may not declare it.

The `database_password` is sensitive and the provider never reads it back: it is write-only, given as a [secret](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#secrets), never compared, and `null` in every state the driver returns. A project read by import has no password in its state, so applying a declaration to an imported project sets its password to the declared secret.

## Driver

`@sanoma-ai/connector-supabase/driver` reads and changes projects through a provider bridge, and calls the Management API (`https://api.supabase.com`) with `fetch`. The `supabase` connector the package root exports carries it, made once per resolved config, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that):

```ts
import { supabase } from "@sanoma-ai/connector-supabase";

export default defineConfig({ workflows, connectors: [supabase], policy });
```

`./driver` (`supabaseDriver`; `supabaseDriver({ bridge })` reads through a bridge of your own, `timeoutMs` bounds a Management API request, 30 seconds by default) and `./fake` (`fakeSupabase`) are internal entries, for tests.

Without `bridge`, it reads through the process's `defaultBridge()` from `@sanoma-ai/bridge`, started on the first call with the binary `startBridge` finds. It configures the provider on the first call with `{ access_token }`, and again when the token changes, when the provider has exited, or when the bridge has forgotten it.

The provider answers a project that does not exist (Supabase's 404) with the state it was given, not with none. So `read` always imports, from the ref alone, never refreshing the state it is given, and a project without a `name` is `gone`.

### Environment

Read on every call, never when the config loads:

| Variable                | What it is                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | A Supabase personal access token ([account tokens](https://supabase.com/dashboard/account/tokens)), for the provider and the Management API |

When the token is unset, a call fails, not retryable, naming it; the worker starts regardless, and the app's connector page shows and sets it. The bridge passes the token to the provider through its config only. The default bridge's binary comes with `@sanoma-ai/bridge` or from `SANOMA_BRIDGE_BIN` (see [the bridge](https://www.npmjs.com/package/@sanoma-ai/bridge#the-binary)), not a credential of the connector; it must trust Supabase's signing key, since the OpenTofu registry serves none for this provider.

### Errors and retries

As for GitHub: the bridge's errors become `DriverError`s with its code as `vendorCode` and the provider's diagnostics in the message, retryable only on `unavailable`, after which the provider is configured again. A Supabase error other than a missing project (a bad token) comes back from the provider as a failed import (`failed_precondition`) with the status and Supabase's message. A Management API error is a `DriverError` with the HTTP `status` and Supabase's message, retryable on a timeout, a rate limit (429) or a server error.

## Testing

`@sanoma-ai/connector-supabase/fake` serves the replies in `testdata/replies` (a project `sanomatestprojectref`, and the provider's answer for a missing one, `sanomamissingproject`) through the real driver over a `stateBridge` of them (`tfFake`), which creates, changes and deletes projects in memory. Its Management API answers from the same projects: each healthy, its pooler `aws-0-<region>.pooler.supabase.com`. Those replies are written by hand to the provider's schema and source, not recorded: no access token was at hand.

```ts
import { fakeSupabase } from "@sanoma-ai/connector-supabase/fake";

const fake = fakeSupabase();
fake.override("project", "sanomatestprojectref", { name: "renamed" }); // drift: the next read returns it
```

It has `put`, `remove` and the faults every fake has, like `fakeGithub`. Import it from `@sanoma-ai/connector-supabase/fake`.

### Recording

The driver's tests replay hand-written fixtures in the recorders' formats until they are recorded. With a token and a throwaway organization (the free plan allows two active projects), record a project's create and delete from a provider-bridge checkout. The repo's own recorder refuses a plan whose config holds a sensitive value, so it is provider-bridge's `bridge-record`, which scrubs the password, also in the msgpack plan:

```sh
SUPABASE_DB_PASSWORD="$(openssl rand -base64 24)" go run ./cmd/bridge-record \
  --provider supabase/supabase --version 1.11.0 --config-env access_token=SUPABASE_ACCESS_TOKEN \
  --change "supabase_project=sanoma-apply-test={\"name\":\"sanoma-apply-test\",\"organization_id\":\"$SUPABASE_TEST_ORG_ID\",\"region\":\"us-east-1\",\"database_password\":\"$SUPABASE_DB_PASSWORD\"}"
```

It deletes the project at the end, also after a failed step. Copy `testdata/replies/supabase_supabase_1.11.0/supabase_project/sanoma-apply-test*` here, with the organization's slug replaced by `sanoma-test-org` and the project's ref by `sanomaapplytestrefab`. The Management API fixtures record against an existing project:

```sh
SANOMA_LIVE=1 SANOMA_RECORD=1 SUPABASE_TEST_PROJECT_REF=<ref> pnpm vitest run connectors/supabase/test/management.test.ts
```

License: FSL-1.1-ALv2.
