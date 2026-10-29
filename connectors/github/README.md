# @sanoma-ai/connector-github

GitHub resources for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): repositories, branch protection rules, team memberships and deploy keys, read through the [`integrations/github`](https://github.com/integrations/terraform-provider-github) OpenTofu provider (6.13.0) on [provider-bridge](https://github.com/Sanoma-AI/provider-bridge), and the company repository's pull requests, through its [remote half](#remote-half).

## Usage

```sh
npm install @sanoma-ai/connector-github
```

Each resource type has two operations, both effect `read` and idempotent, with the id as the policy's `target`; a repository and a deploy key are writable, so they have the change operations too, which only apply calls:

| Type                    | Operations                                                                                   | Identity                                                | Binding id                             |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------- |
| `repository`            | `github.repository.read`, `.import`, and `.plan`, `.create`, `.update`, `.delete`            | `owner/name`                                            | `node_id`                              |
| `branch_protection`     | `github.branch_protection.read`, `github.branch_protection.import`                           | `repository_id:pattern` (the repository's `owner/name`) | `id` (its node id, `BPR_…`)            |
| `team_membership`       | `github.team_membership.read`, `github.team_membership.import`                               | `owner/team_id:username`                                | `id` (`<owner>/<team_id>:<username>`)  |
| `repository_deploy_key` | `github.repository_deploy_key.read`, `.import`, and `.plan`, `.create`, `.update`, `.delete` | none: found by its binding                              | `id` (`<owner>/<repository>:<key id>`) |

`import` takes `{ id }`, an identity or a binding id (what the [lockfile](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#bindings) keeps, which a rename does not change), and returns the object's `state`. Which organization or user owns a repository is a fact about it, so it is in the resource, never in the environment: a repository and a team membership have an `owner` field, which a data file declares, and every name of a repository the connector shows is `<owner>/<name>`, GitHub's `full_name` (a repository's identity, a rule's repository, a deploy key's repository and binding id). The provider takes the owner as its configuration and a name without it, so the driver configures it, on each call, for the owner the call names: by its declaration's `owner` (or its repository's), its state's, or its id's `<owner>/`. A node id (a repository's `R_kgD…` or legacy one, a rule's `BPR_…`) is resolved first, with one GraphQL `node(id)` query, to its owner and the name the provider imports by (a repository's name, a rule's `repository:pattern`), unless the call's state names the owner (the provider then reads by that state); a node id GitHub does not know is gone. Write the owner as GitHub does (`Sanoma-AI`): a state's owner is GitHub's, and drift compares it as declared. A call that names no owner is refused, as is one that names two (a declaration's `owner` against its binding's: a repository moves owner at GitHub, not here): nothing is read under the token's own user by default. Calls for a second owner work: the provider is configured for each owner in turn, a call for one waiting for those running for the other. The fake finds an object by its binding id too, with no query; `read` takes a state an earlier call returned (`{ id, state, handle }`), or just `{ id }`, and returns its fresh `state`, or `gone: true` when it no longer exists. See [Resources](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#resources).

A deploy key is an SSH key that may fetch one repository (read-only unless `read_only: false`), what going live gives the company's host to clone the private repository with ([Cloning a private repository](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/README.md#cloning-a-private-repository)). GitHub changes no field of one, so a change to any is a replace (`update` deletes the old key and makes a new one), and GitHub reads `key` back without its comment, so declare it as `<type> <base64>`.

A repository's `create`, `update` and `delete` plan and apply through the provider (see [`@sanoma-ai/bridge`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers)); a create's `id` is the new repository's node id. Their tests replay synthetic replies of an empty repository and of a deploy key on it (`sanoma-apply-test*` in `@sanoma-ai/bridge`'s `testdata/replies`, in the provider's shape) until they are recorded in a test organization.

A data file declares resources with the constructors in `@sanoma-ai/connector-github/resources`:

```ts
import { github } from "@sanoma-ai/connector-github/resources";

export const site = github.repository({
  owner: "acme",
  name: "website",
  delete_branch_on_merge: true,
  has_wiki: false,
});
export const siteMain = github.branch_protection({ repository_id: site, pattern: "main", enforce_admins: true });
export const siteKey = github.repository_deploy_key({
  repository: site,
  title: "CI",
  key: "ssh-rsa AAAA…",
  read_only: true,
});
```

A branch protection rule names its repository by the declared repository itself (`repository_id: site`), which stands for its identity, `acme/website`: the rule is `acme/website:main`, and takes its owner from the repository; a deploy key's `repository` the same way, so a data file states the owner once per repository. Only those take a resource, and only a repository; see [Data files](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#data-files).

The fields are the provider's attributes, by their names, and `owner` (required) on a repository and a team membership. A list block of at most one item (`pages`, `security_and_analysis`, `template`) is one object. Only declared fields are compared for drift; sets (`topics`, and five lists in a branch protection rule) are compared in any order.

The logo is GitHub's mark from [Octicons](https://primer.style/octicons/) (`mark-github`, MIT), there only to identify the service an operation calls.

## Remote half

The `github` connector carries GitHub's remote half (`githubRemote`, `withSetup(..., { remote })`): what a change is reviewed and merged through when the company's repository is on GitHub. `ResolvedConfig.remotes` holds it under `github`, and `remoteFor(remotes, url)` from `@sanoma-ai/workflows` finds it for a clone URL, `https://github.com/<owner>/<repo>(.git)`, `git@github.com:<owner>/<repo>(.git)` or `ssh://git@github.com/<owner>/<repo>(.git)`. `open(repo, { secrets })` gives the repository's `SourceHost` (the type is in `@sanoma-ai/workflows`):

| Method                                                       | GitHub's REST API                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pullRequestFor(branch)`, `pullRequest(number)`              | `GET /repos/{owner}/{repo}/pulls?state=all&head={owner}:{branch}` (the open one, else the latest), `GET …/pulls/{number}`                                                                                                                                                                 |
| `openPullRequest({ branch, base, title, body })`             | `POST …/pulls`; the branch's open one into `base` when it has one already                                                                                                                                                                                                                 |
| `mergePullRequest(number, { sha, method: "squash", title })` | `PUT …/pulls/{number}/merge` at `sha`; a `DriverError` with `vendorCode` `head_moved` on 409 (the branch moved on), `not_mergeable` on 405, unless the pull request is merged already (a retry whose first answer was lost), when it answers the merge commit                             |
| `closePullRequest(number)`, `deleteBranch(branch)`           | `PATCH …/pulls/{number}`, `DELETE …/git/refs/heads/{branch}` (nothing when it is gone)                                                                                                                                                                                                    |
| `setStatus({ sha, state, description, targetUrl })`          | `POST …/statuses/{sha}` with context `sanoma`, the description cut to GitHub's 140 characters                                                                                                                                                                                             |
| `enforcement(base)`                                          | `GET …/rules/branches/{base}`: `pullRequest` when a ruleset requires a pull request, `check` when one requires the `sanoma` status check (rulesets only, not classic branch protection); GitHub's 403 for a plan without rules (a private repository on Free) is neither, with the reason |

Every call is plain `fetch` with GitHub's media type and `X-GitHub-Api-Version: 2022-11-28`. A failure is a `DriverError` with GitHub's status and message, retryable on a server error or a rate limit. A commit status works with a person's token and with the App; check runs would need an App, so the half sets statuses only.

**Tokens**, read through `secrets` on every call (the app's are the environment's, then the stored credentials), never logged: `githubToken(secrets, owner, prefer)` mints an installation token of the company's GitHub App when its keys are stored (`SANOMA_GITHUB_APP_ID`, `SANOMA_GITHUB_APP_PEM`, which the app's **Create GitHub App** stores; `GITHUB_APP_SECRETS` names them) and the App is installed on the owner (among its first 100 installations), signed with `appJwt`, and otherwise takes `GITHUB_TOKEN`, also when the App's keys do not work; `prefer: "token"` tries `GITHUB_TOKEN` first, as going live's push does. An opened repository mints its installation token for that repository alone (GITHUB_TOKEN when the installation does not cover it) and keeps its token for the calls made together and after them: an installation token until five minutes before its hour is out, a person's for five minutes, either until GitHub answers 401. With neither, a call fails, not retryable, `vendorCode` `no_token`. A `GITHUB_TOKEN` for the company's repository needs, as a fine-grained token on it: Contents, Pull requests and Commit statuses: write (Metadata: read comes with them), and the App the same.

**Webhooks:** `webhook(request, { secrets })` verifies `X-Hub-Signature-256` (HMAC SHA-256 of the body's bytes under `SANOMA_GITHUB_WEBHOOK_SECRET`, compared in constant time) and throws a `DriverError` (`bad_signature`, status 401) for a missing or wrong one, or `no_webhook_secret` when the secret is not stored. A `push` to a branch is `{ kind: "pushed", repo, branch, head }`; a `pull_request` `closed` is `{ kind: "closed", repo, branch, number, merged, sha }`, `sha` the merge commit when merged; any other event or action, a tag's push, a deleted branch and a fork's pull request are `[]`. A JSON body and a form-encoded `payload` are both read.

**A change on GitHub** ([changes](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#changes)): **Send for review** pushes the draft's branch `draft/<id>` and opens its pull request into `main`, titled as the change; the head's `sanoma` status says what Publish waits for and links the change's page in the app: pending, or failure while the checks fail or the policy denies. **Publish** sets it to success, squash-merges the pull request at that head as `<title> (#<number>)` and deletes the branch; **Reject** closes the pull request. Nothing else is written to the pull request: no comment and no card. A ruleset on `main` requiring a pull request and the `sanoma` status check is what makes a change outside Sanoma impossible; the Permissions page's line under the grid is `enforcement("main")`, and on a private repository on GitHub Free it reads as enforcing neither, with GitHub's reason. GitHub's deliveries reach an instance at `https://<host>/webhooks/github` (the App **Create GitHub App** makes subscribes to `push` and `pull_request`, with commit statuses), so a push to the branch or a pull request merged or closed on GitHub reaches the change, and a push to `main` applies the declared hosts; a laptop has no public address and gets none.

`owners({ secrets })` lists the accounts the App is installed on (`GET /app/installations`, signed as the App), what going live offers besides the token's own.

`@sanoma-ai/connector-github/remote` exports `githubRemote`, `githubToken`, `appJwt` and `GITHUB_APP_SECRETS`.

## Resource types

`src/resources.gen.ts` is generated from the provider's schema by `pnpm generate`, which runs [`@sanoma-ai/bridge/tfschema`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/src/tfschema/AGENTS.md) with `src/resources.config.ts`: the provider (its release, sha256 and recorded schema are `@sanoma-ai/bridge`'s pin and fixture), the types to generate, and the attributes whose change replaces the object (ForceNew in the provider's source, which the schema does not carry). It is checked in and never edited by hand; `pnpm generate` on a clean tree changes nothing. `src/connector.ts` is the rest, one `tfConnector` record from [`@sanoma-ai/bridge/connector`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/bridge/README.md#connectors-for-opentofu-providers): each type's title, identity, `find` and `bindingId`, the fields that name another resource (`branch_protection.repository_id`, `repository_deploy_key.repository`), and GitHub's title, logo and package. The connector, the constructors, the driver and the fake all derive from it.

Attributes that are computed and not optional (`html_url`, `repo_id`) are vendor-owned: never drift, and a data file may not declare them. Those the provider marks computed and optional (`etag`, `topics`, `visibility`, `default_branch`) are yours to set, and compared only when declared.

## Driver

`@sanoma-ai/connector-github/driver` reads through a provider bridge. The `github` connector the package root exports carries it, made once per resolved config, and its fake (`withSetup` from `@sanoma-ai/workflows`), so a config names the connector alone and workflows never import the driver (the lint refuses that):

```ts
import { github } from "@sanoma-ai/connector-github";

export default defineConfig({ workflows, connectors: [github], policy });
```

`./driver` (`githubDriver`; `githubDriver({ bridge })` reads through a bridge of your own) and `./fake` (`fakeGithub`) are internal entries, for tests.

Without `bridge`, it reads through the process's `defaultBridge()` from `@sanoma-ai/bridge`, started on the first call with the binary `startBridge` finds; `bridge` is any `ProviderClient` (a `Bridge` from `startBridge()`, or `stateBridge` in tests). It configures the provider on the first call with `{ owner, token }`, the owner the call names and the token from the environment, and again when either changes (closing it first: the bridge refuses a second config), when the provider has exited, or when the bridge has forgotten it (`ensureConfigured`). `read` without a state (or with one that has no `id`) imports, which reads the object too. States leave the driver in the resource's shape, with sensitive attributes set to `null`; the provider's private data and state version travel in the opaque `handle`.

### Environment

Read on every call, never when the config loads:

| Variable       | What it is                                                            |
| -------------- | --------------------------------------------------------------------- |
| `GITHUB_TOKEN` | A GitHub token that can read the repositories, rules and teams named. |

When the token is unset, a call fails, not retryable, naming it; the worker starts regardless, and the app's connector page shows and sets it. The bridge passes the token and the owner to the provider through its config only, never through the provider's environment. The default bridge's binary comes with `@sanoma-ai/bridge` or from `SANOMA_BRIDGE_BIN` (see [the bridge](https://www.npmjs.com/package/@sanoma-ai/bridge#the-binary)), not a credential of the connector.

### Errors and retries

The bridge's errors become `DriverError`s whose `vendorCode` is the bridge's code and whose message carries the provider's diagnostics. `unavailable` (the provider process failed or exited) is retryable, and the next try configures the provider again; anything else is not. GitHub's provider reports an object that does not exist as a failed import (`failed_precondition`, "could not find a branch protection rule with the pattern 'main'"), not as `not_found`; the connector's `missing` says so, so `import` answers `{ gone: true }` for it, as for `not_found`.

## Testing

`@sanoma-ai/connector-github/fake` is GitHub as it was when the replies in `@sanoma-ai/bridge`'s `testdata/replies` were recorded (the `Sanoma-AI/sanoma` and `Sanoma-AI/provider-bridge` repositories; `provider-bridge:main` has no branch protection), served through the real driver over a `stateBridge` of them (`tfFake`). It needs no token and reaches nothing. Its calls name owners as the driver's do (`Sanoma-AI/sanoma`), but it holds its objects by the provider's import ids (`sanoma`, `sanoma:main`), what `put`, `override` and `remove` take, and not by owner: a repository's `owner` is its `full_name`'s, else the call's.

```ts
import { withSetup } from "@sanoma-ai/workflows";
import { github } from "@sanoma-ai/connector-github";
import { fakeGithub } from "@sanoma-ai/connector-github/fake";

const fake = fakeGithub();
const worker = await startWorker({
  connectors: [withSetup(github, { driver: () => fake.driver, fake: () => fake })],
  /* ... */
});

fake.put("repository", "website", { name: "website", has_wiki: false }, { from: "sanoma" }); // a copy of a recorded one
fake.override("repository", "sanoma", { delete_branch_on_merge: true }); // drift: the next read returns it
fake.remove("repository", "sanoma"); // the next read and import say it is gone
```

`put` and `override` take fields in the resource's shape, as a read returns them (a block of one is an object). `remove` answers an import as the provider does: a branch protection rule with the provider's `failed_precondition` diagnostic, anything else `not_found`. It has the faults every fake has (`failNext`, `loseReply`, `rateLimit`, `hold`, `reset`, `update`); see [Fakes for tests](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#fakes-for-tests). Import it from `@sanoma-ai/connector-github/fake`.

License: FSL-1.1-ALv2.
