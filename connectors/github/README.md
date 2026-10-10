# @sanoma/connector-github

GitHub resources for [`@sanoma/workflows`](https://www.npmjs.com/package/@sanoma/workflows): repositories, branch protection rules and team memberships, read through the [`integrations/github`](https://github.com/integrations/terraform-provider-github) OpenTofu provider (6.13.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge). It reads only: there is no create, update or delete yet.

## Usage

```sh
npm install @sanoma/connector-github
```

Each resource type has two operations, both effect `read` and idempotent, with the import id as the policy's `target`:

| Type                | Operations                                                         | Import id (identity)    |
| ------------------- | ------------------------------------------------------------------ | ----------------------- |
| `repository`        | `github.repository.read`, `github.repository.import`               | `name`                  |
| `branch_protection` | `github.branch_protection.read`, `github.branch_protection.import` | `repository_id:pattern` |
| `team_membership`   | `github.team_membership.read`, `github.team_membership.import`     | `team_id:username`      |

`import` takes `{ id }` and returns the object's `state`; `read` takes a state an earlier call returned (`{ id, state, handle }`), or just `{ id }`, and returns its fresh `state`, or `gone: true` when it no longer exists. See [Resources](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#resources).

A data file declares resources with the constructors in `@sanoma/connector-github/resources`:

```ts
import { github } from "@sanoma/connector-github/resources";

export const site = github.repository({ name: "website", delete_branch_on_merge: true, has_wiki: false });
export const siteMain = github.branch_protection({ repository_id: site, pattern: "main", enforce_admins: true });
```

A branch protection rule names its repository by the declared repository itself (`repository_id: site`), which stands for its name: the rule is `website:main`. Only `repository_id` takes a resource, and only a repository; see [Data files](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#data-files).

The fields are the provider's attributes, by their names. A list block of at most one item (`pages`, `security_and_analysis`, `template`) is one object. Only declared fields are compared for drift; sets (`topics`, and five lists in a branch protection rule) are compared in any order.

The logo is GitHub's mark from [Octicons](https://primer.style/octicons/) (`mark-github`, MIT), there only to identify the service an operation calls.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate`, which runs [`@sanoma/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/src/tfschema/AGENTS.md) with `src/resources.config.ts`: the provider (its release, sha256 and recorded schema are `@sanoma/bridge`'s pin and fixture), the types to generate, and the attributes whose change replaces the object (ForceNew in the provider's source, which the schema does not carry). It is checked in and never edited by hand; `pnpm generate` on a clean tree changes nothing. `src/connector.ts` is the rest, one `tfConnector` record from [`@sanoma/bridge/connector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers): each type's title, identity and `find`, the field that names another resource (`branch_protection.repository_id`), and GitHub's title, logo and package. The connector, the constructors, the driver and the fake all derive from it.

Attributes that are computed and not optional (`html_url`, `repo_id`) are vendor-owned: never drift, and a data file may not declare them. Those the provider marks computed and optional (`etag`, `topics`, `visibility`, `default_branch`) are yours to set, and compared only when declared.

## Driver

`@sanoma/connector-github/driver` reads through a provider bridge. Workflows never import it; the config that starts the worker does:

```ts
import { githubDriver } from "@sanoma/connector-github/driver";

const drivers = [githubDriver({ bridge, owner: "Sanoma-AI" })]; // bridge: `startBridge()` from @sanoma/bridge
```

`bridge` is any `ProviderClient` (a `Bridge` from `startBridge()`, or `stateBridge` in tests). It configures the provider on the first call with `{ owner, token }`, and again when the token changes (closing it first: the bridge refuses a second config), when the provider has exited, or when the bridge has forgotten it (`ensureConfigured`). `read` without a state (or with one that has no `id`) imports, which reads the object too. States leave the driver in the resource's shape, with sensitive attributes set to `null`; the provider's private data and state version travel in the opaque `handle`.

### Environment

Read on every call, never when the config loads:

| Variable       | What it is                                                            |
| -------------- | --------------------------------------------------------------------- |
| `GITHUB_TOKEN` | A GitHub token that can read the repositories, rules and teams named. |

When it is unset, a call fails, not retryable, naming it. The bridge passes it to the provider through its config only, never through the provider's environment.

### Errors and retries

The bridge's errors become `DriverError`s whose `vendorCode` is the bridge's code and whose message carries the provider's diagnostics. `unavailable` (the provider process failed or exited) is retryable, and the next try configures the provider again; anything else is not. GitHub's provider reports an object that does not exist as a failed import (`failed_precondition`, "could not find a branch protection rule with the pattern 'main'"), not as `not_found`.

## Testing

`@sanoma/connector-github/fake` is GitHub as it was when the replies in `@sanoma/bridge`'s `testdata/replies` were recorded (the `Sanoma-AI/sanoma` and `Sanoma-AI/provider-bridge` repositories; `provider-bridge:main` has no branch protection), served through the real driver over a `stateBridge` of them (`tfFake`). It needs no token and reaches nothing.

```ts
import { fakeGithub } from "@sanoma/connector-github/fake";

const fake = fakeGithub();
const worker = await startWorker({ connectors: [github], drivers: [fake.driver] /* , ... */ });

fake.override("repository", "sanoma", { delete_branch_on_merge: true }); // drift: the next read returns it
fake.remove("repository", "sanoma"); // the next read says it is gone
```

`override` takes fields in the resource's shape, as a read returns them (a block of one is an object). It has the faults every fake has (`failNext`, `loseReply`, `rateLimit`, `hold`, `reset`, `update`); see [Fakes for tests](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#fakes-for-tests). `@sanoma/testing` re-exports `fakeGithub`.

License: Apache-2.0.
