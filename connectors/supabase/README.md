# @sanoma-ai/connector-supabase

Supabase projects for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows), read through the [`supabase/supabase`](https://github.com/supabase/terraform-provider-supabase) OpenTofu provider (1.11.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge). It reads only: there is no create, update or delete yet.

## Usage

```sh
npm install @sanoma-ai/connector-supabase
```

The one resource type has two operations, both effect `read` and idempotent, with the project's ref as the policy's `target`:

| Type      | Operations                                         | Import id               |
| --------- | -------------------------------------------------- | ----------------------- |
| `project` | `supabase.project.read`, `supabase.project.import` | `id`, the project's ref |

`import` takes `{ id }` and returns the project's `state`; `read` takes a state an earlier call returned, or just `{ id }`, and returns its fresh `state`, or `gone: true`. See [Resources](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#resources).

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

The fields are the provider's attributes, by their names: `organization_id` is the organization's slug. Only declared fields are compared for drift. The provider reads `instance_size` back only for a project with a compute add-on (`null` otherwise) and never reads `timeouts`, so declare neither unless that holds. The project's host, pooler and health are not attributes of the provider's project, so they are not here.

The logo is Supabase's bolt from [Simple Icons](https://simpleicons.org/?q=supabase) (CC0), there only to identify the service an operation calls.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate`, which runs [`@sanoma-ai/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/src/tfschema/AGENTS.md) with `src/resources.config.ts`: the provider (its release, sha256 and recorded schema are `@sanoma-ai/bridge`'s pin and fixture), the type, and the attributes whose change replaces the project (`organization_id` and `region`, which the provider's update refuses). It is checked in and never edited by hand; `pnpm generate` on a clean tree changes nothing. `src/connector.ts` is the rest, one `tfConnector` record from [`@sanoma-ai/bridge/connector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers): the type's title (no identity: a project is found by its binding, its ref), when a state is no project, and Supabase's title and logo. The ref (`id`) is vendor-owned and a data file may not declare it.

The `database_password` is sensitive and the provider never reads it back: it is write-only, given as a [secret](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#secrets), never compared, and `null` in every state the driver returns.

## Driver

`@sanoma-ai/connector-supabase/driver` reads through a provider bridge. The `supabase` connector the package root exports carries it, made once per resolved config, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that):

```ts
import { supabase } from "@sanoma-ai/connector-supabase";

export default defineConfig({ workflows, connectors: [supabase], policy });
```

`./driver` (`supabaseDriver`; `supabaseDriver({ bridge })` reads through a bridge of your own) and `./fake` (`fakeSupabase`) are internal entries, for tests.

Without `bridge`, it reads through the process's `defaultBridge()` from `@sanoma-ai/bridge`, started on the first call with the binary `startBridge` finds. It configures the provider on the first call with `{ access_token }`, and again when the token changes, when the provider has exited, or when the bridge has forgotten it.

The provider answers a project that does not exist (Supabase's 404) with the state it was given, not with none. So `read` always imports, from the ref alone, never refreshing the state it is given, and a project without a `name` is `gone`.

### Environment

Read on every call, never when the config loads:

| Variable                | What it is                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | A Supabase personal access token ([account tokens](https://supabase.com/dashboard/account/tokens)) |

When the token is unset, a call fails, not retryable, naming it; the worker starts regardless, and the app's connector page shows and sets it. The bridge passes the token to the provider through its config only. The default bridge's binary comes with `@sanoma-ai/bridge` or from `SANOMA_BRIDGE_BIN` (see [the bridge](https://www.npmjs.com/package/@sanoma-ai/bridge#the-binary)), not a credential of the connector; it must trust Supabase's signing key, since the OpenTofu registry serves none for this provider.

### Errors and retries

As for GitHub: the bridge's errors become `DriverError`s with its code as `vendorCode` and the provider's diagnostics in the message, retryable only on `unavailable`, after which the provider is configured again. A Supabase error other than a missing project (a bad token) comes back from the provider as a failed import (`failed_precondition`) with the status and Supabase's message.

## Testing

`@sanoma-ai/connector-supabase/fake` serves the replies in `testdata/replies` (a project `sanomatestprojectref`, and the provider's answer for a missing one, `sanomamissingproject`) through the real driver over a `stateBridge` of them (`tfFake`). Those replies are written by hand to the provider's schema and source, not recorded: no access token was at hand. Replace them with recorded ones (provider-bridge's `bridge-record`) when there is one.

```ts
import { fakeSupabase } from "@sanoma-ai/connector-supabase/fake";

const fake = fakeSupabase();
fake.override("project", "sanomatestprojectref", { name: "renamed" }); // drift: the next read returns it
```

It has `put`, `remove` and the faults every fake has, like `fakeGithub`. Import it from `@sanoma-ai/connector-supabase/fake`.

License: FSL-1.1-ALv2.
