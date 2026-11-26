# @sanoma-ai/connector-sanoma-cloud

Sanoma Cloud for [`sanoma/workflows`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md): the company's database, host and coding agents' boxes in Sanoma's own accounts, for a company with no database, hosting or sandbox account of its own, declared in its repository like any other. The driver, and the backend that opens the boxes, are clients of sanoma-ops's `cloud-*` workflows over the public api of www.sanoma.work, with the company's Cloud token.

## Usage

```sh
npm install @sanoma-ai/connector-sanoma-cloud
```

```ts
// sanoma.config.ts
import { cloud } from "@sanoma-ai/connector-sanoma-cloud";

export default defineConfig({ connectors: [cloud /* , github, … */] });
```

A data file declares the database, the host and the boxes; apply makes them at the Cloud:

```ts
// resources/sanoma/infra.ts
import { github } from "@sanoma-ai/connector-github/resources";
import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";

export const repo = github.repository({ owner: "acme", name: "acme-ops", visibility: "private" });
export const store = cloud.database({ region: "us-east" });
export const host = cloud.host({ hostname: "acme.sanoma.work", database: store });
export const box = cloud.sandbox({});
export default [repo, store, host, box];
```

The host says only its decisions, as `cloudflare.host` does: apply gives it the repository the app runs from (the declared `github.repository` that is its `origin`, else the one its data file declares, else `origin`'s URL) and that repository's default branch. There is no `secrets` block and no wakeup: the Cloud mints the instance's bootstrap (its database URL, keys and tokens) and binds it to the host itself, and the host wakes itself through its own Worker's alarm.

### The company and its address

A Sanoma Cloud company is an id that never changes, and the Cloud token is for one company: its own. The database, the host and the boxes are the token's company's, so none names it, and the lockfile binds each to its id. The company's address, `<slug>.sanoma.work`, is the host's `hostname` (its slug 3 to 40 lower case letters, digits and single dashes, a dash at neither end, and not one Sanoma keeps, such as `www`: `CLOUD_SLUG`, refused as the declaration is read), which can change: apply plans an update of the same host, and the Cloud moves the company to the new address (a rename). The old address stops answering and stays the company's, so renaming back works; people sign in again at the new one.

A token that is for no company yet is refused at plan (`no_company`), and one that lists several (`not_one`): the wizard on www.sanoma.work makes the company with its token, and going live from the app makes it through the account's `repository` below. A new company declares both from the start: `sanoma`'s template (`resources/sanoma/infra.ts`, whose `hostname` `sanoma init` writes from the company's name) and Sanoma-AI/company-template, its copy, declare `cloud.database({ region: "us-east" })` and `cloud.host({ hostname: "<slug>.sanoma.work", database })`, and nothing is made until the company goes live. The app's Go live applies them as they are (the built-in `go-live-cloud`, from Hosting), through the account's operations below; going live on the company's own accounts instead writes the file again while nothing of it is bound.

### `cloud.database`

| Field    | What it is                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `region` | Optional: `us-east` (the Cloud's default), `us-west`, `eu-central`, `eu-west` or `ap-southeast` (`REGIONS`). It cannot move. |

Its state adds what the Cloud sets: `id` (the company's id, its binding) and `healthy`. It meets the [`Database` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#databases): it pauses (a Neon compute in the Cloud's organization) and does not branch yet. Its `storeUrl` stores nothing and says so: the Cloud binds the URL to the host, and a laptop never needs it.

### `cloud.host`

| Field      | What it is                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hostname` | The company's address, `<slug>.sanoma.work` (customers' own domains come later). A change renames the company in place.                                                        |
| `database` | The declared `cloud.database` it runs on, the company's: the Cloud makes no host without it. The Cloud binds its URL to the host itself (write-only, so apply never plans it). |
| `source`   | Optional override of the derived repository: a clone URL, or a declared `github.repository`.                                                                                   |
| `ref`      | Optional override of the derived branch. Apply resolves the branch to the commit it runs (`revision`, which a data file may not declare), so a merge deploys it.               |

Its state adds `id` (the company's id, its binding, the database's too), `revision`, `url` and `healthy`. It meets the [`Host` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#hosts) as a host that binds its own bootstrap (`bindsBootstrap`, so it takes no `secrets`): it ends with its process once its worker is idle and starts on the next wake, its URL is public, it runs the Cloud's runtime image rather than building from git, and it has no fixed egress. A deploy moves it to another revision or another `hostname`; another `source` or `ref` plans a replace, which `update` refuses: delete it and declare it again. A create binds a host the wizard made rather than make it again, and moves it to the declared `hostname` and apply's revision when it is at another; one from another `source` or `ref` it refuses (`immutable`), as it refuses a database the wizard made in another `region`. An update that finds its change made already (a retry) is done.

| Operation                                     | Effect  | What it does                                                                                                                                                             |
| --------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud.database.read`, `.import`, `.plan`     | `read`  | Read the company's database from `cloud-list`; plan a change.                                                                                                            |
| `cloud.database.create`, `.update`, `.delete` | `write` | Apply's: make it with `cloud-signup` (or bind the one the wizard made), refuse a new `region`, close it with `cloud-close`.                                              |
| `cloud.database.storeUrl`                     | `read`  | Nothing: says the host binds the URL; apply calls it after a create.                                                                                                     |
| `cloud.host.read`, `.import`, `.plan`         | `read`  | Read the company's host from `cloud-list`; plan a change.                                                                                                                |
| `cloud.host.create`, `.update`, `.delete`     | `write` | Apply's: make it with `cloud-signup` (or bind the one the wizard made), move it to apply's revision or another address with `cloud-deploy`, close it with `cloud-close`. |

### `cloud.sandbox`

`cloud.sandbox({})` takes no fields: the Cloud chooses each box's image (Sanoma's box image of its own release) and size, and the company's limits. Its state is `id` (the company's id, its binding) and `healthy` (the company is open). Apply makes nothing: a create or an update binds the token's company, a read says whether it is open, and a delete forgets the declaration, the boxes staying until the company closes, which discards them. It meets the [`Sandbox` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#sandboxes) with every capability: a box's files and its memory survive a stop (an Agent37 sleep), and `expose` reaches one of its ports. Its inputs name neither image nor size (`inputs: {}`), so the app opens a box with the hosts alone.

Its backend (`cloudBackend`, `src/backend.ts`), which the connector attaches (`withSetup({ sandbox })`) and the app makes with the company's secrets, opens a person's box through sanoma-ops, which holds Sanoma's Agent37 key and never gives it out. The instance then talks to its box directly over a short-lived link; nothing is relayed through Sanoma.

| Call                    | Workflow            | Input             | What it does                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `open({ name, hosts })` | `cloud-box-open`    | `{ name, hosts }` | The box found or made, woken, Sanoma's runner started in it, reaching only `hosts`; answers `{ id, url, expiresAt, protocol }`, `url` a link to the runner's port (its `expiresAt` the Cloud's: the backend keeps the rest). A runner of another protocol than this release's is refused (`protocol`). |
| `expose(port)`          | `cloud-box-expose`  | `{ name, port }`  | A link to another port of the box, `{ url, expiresAt }`, the backend keeping `url`.                                                                                                                                                                                                                    |
| `stop()`                | `cloud-box-stop`    | `{ name }`        | What runs in the box killed through the runner (30 s at most), then the box put to sleep.                                                                                                                                                                                                              |
| `discard({ name })`     | `cloud-box-discard` | `{ name }`        | The box deleted, with what Agent37 kept of it; none there is done.                                                                                                                                                                                                                                     |

A box's name is lowercase letters, digits, `-`, `_` and `%XX` escapes, at most 200 characters, and its hosts 1 to 100 domain names (a `*.` before one of two labels or more for its subdomains, never an address); the backend refuses anything else (`invalid_box`) before it starts a workflow, with the rule the Cloud and the fake check (`BOX_INPUTS`). The package root exports the rules (`import { BOX_INPUTS, boxProblem } from "@sanoma-ai/connector-sanoma-cloud"`), so the service on the other side checks the same ones in its workflows: `boxProblem(BOX_INPUTS.open, input)` says what is wrong with an open's input, for people, and is undefined when nothing is (`BOX_INPUTS.name` for the other calls). Its `stop` waits for the runner to kill what runs in the box (`runnerBox`'s, 30 s at most), then starts `cloud-box-stop`. The Cloud names a box `<company id>/<name>` in the group of the company's id, so one company never reaches another's, and keeps a company to 5 boxes, 2 of them awake at once; when Sanoma's account has every box it may keep awake awake, the open fails with "All of Sanoma Cloud's agent boxes are busy. Try again in a few minutes." A link reaches its port with no credential until `expiresAt` (an hour); a connection opened before then stays up after it, and nothing renews a link a turn outlives. Each call starts a run of its own, with no run id: the Cloud opens one box of a name at a time and finds the one there, so a call is safe to make again.

### The account

The host names three operations of the token's account (`HostSpec.account`), which the app calls to go live from a computer, each on the token's company. They are not resources: nothing declares them.

| Operation                  | Effect   | What it does                                                                                                                                                                                                                                |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.company.available`  | `read`   | `{ slug }` to `{ available, yours }`: whether `<slug>.sanoma.work` is free, or the account's own already, with `cloud-available`.                                                                                                           |
| `cloud.company.repository` | `write`  | `{ slug }` to `{ owner, name }`: the company's repository, made empty by the Sanoma.work GitHub App with `cloud-signup`'s `repository` part, or the one `cloud-list` shows. A token that is for no company yet makes one at `slug` with it. |
| `cloud.company.invite`     | `access` | `{ email }` to `{ url }`: a one-use link that signs the account's own email in on the company's host, with `cloud-invite`. The link is opaque.                                                                                              |

## Driver

`cloudDriver` (and the boxes' backend, `workflowsApi`) starts sanoma-ops's workflows through `POST <SANOMA_CLOUD_URL>/api/call` (the app's plain-JSON form of a site's `api`): `<workflow>.start` with an id made from the call's idempotency key, so a retry resumes the same run, then `<workflow>.result` until the run ends (each request waits up to 20 s; `run_running` means wait again), with the token as `Authorization: Bearer`. The token's company is `cloud-list {}` (one row, or none); a read starts `cloud-list { id }`, and an empty list is a missing object; `create` starts `cloud-signup { id, part, repository?, ref?, revision?, region? }`, `update` of the host `cloud-deploy { id, slug, revision }` (`slug` the declared `hostname`'s: another than the company's is a rename), and `delete` `cloud-close { id, part }` once `cloud-list` shows the part. The account's operations start `cloud-available { slug }`, `cloud-signup { id, part: "repository" }` (`{ slug, name, part: "repository" }` while the token is for no company) then `cloud-list {}`, and `cloud-invite { id, email }`; the boxes' backend starts the `cloud-box-*` workflows (`cloud.sandbox`, above). An answer that is not what the workflow says (`cloud-list`'s rows among them, each with its `name`, `createdAt` and `trialEndsAt`, and a box's link) is refused.

### Environment

The driver reads the company's Cloud token, `sca_…`, from the company's secrets as `SANOMA_CLOUD_TOKEN` on each call, and the boxes' backend at each open, never from the environment on its own. On a computer the app stores it there (Hosting's sign-in to Sanoma, or a Cloud token pasted there). On a Cloud host it is the host's variable, which the company's `secrets.ts` binds (`SANOMA_CLOUD_TOKEN: { env: "SANOMA_CLOUD_TOKEN" }`), so the instance applies its own file. A call without one, or with a value that is no Cloud token, is refused (`no_token`), and the refusal names Hosting.

| Variable           | What it is                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| `SANOMA_CLOUD_URL` | Optional: where the api answers, `https://www.sanoma.work` unless set. |

### Errors and retries

A run that fails fails the call with its failure, which the api answers with a 422 (`DriverError`, its status and `code` as `vendorCode`), in the workflow's own words, which it writes for people; any other failure says `Sanoma Cloud: <workflow>:` first. Only no reply, a 408, a 429 and a 5xx are retryable (`retryableStatus`); a workflow's refusal (a slug someone else holds, a region the Cloud has not) and a refused token (401, said without its value) are final. A run that has not ended in 15 minutes (`runTimeoutMs`) fails retryable, and the retry resumes it. The driver's own refusals have a `vendorCode`: `no_token`, `no_company`, `not_one`, `immutable`, `plan_changed`, `no_repository`, `gone`, `not_made`, and the boxes' backend's `protocol` and `invalid_box`.

### Running it live

`test/live.ts` runs the operations against a real sanoma-ops by hand, never in CI: it makes the database and host of the scratch company the token is for from a repository the token's account can use, waits for `/healthz`, checks a plan at the same revision is `none`, and closes both, which closes the company and revokes its token: each run needs a new one. With `SANOMA_CLOUD_TEST_DATABASE_URL`, the company database's URL read from sanoma-ops's store by hand, it runs the Database kit's run checks too (the suspend check stays the fake's). The Host kit's run checks need the same database and a stop the Cloud makes, so they run on the fake only for now.

```sh
pnpm build
SANOMA_LIVE=1 SANOMA_CLOUD_TOKEN=sca_... SANOMA_CLOUD_TEST_REPOSITORY=Sanoma-AI/host-check-company \
  node connectors/sanoma-cloud/test/live.ts
```

`SANOMA_CLOUD_URL`, `SANOMA_CLOUD_TEST_SLUG` (the company's address, default `host-check`: another renames it), `SANOMA_CLOUD_TEST_REF` (`main`) and `SANOMA_CLOUD_TEST_REGION` (`us-east`) are optional.

## The fake

`fakeCloud()` is an in-memory Cloud with one token and its one company (`state.company`): the token's from the start at `slug` when given, else made by the first sign-up by slug, its id `fake-company-<n>`, with the parts `cloud-signup` made (a host only once there is a database), all healthy; a host runs `start`'s runtime (a stub answering `/healthz` and `/wake` by default) behind an address in this process that outlives it, starts it on a request, and moves it on a deploy, which takes a new slug too, the old one staying the company's (`cloud-available` says `yours`); `cloud-close` removes a part, the database only once the host is gone, and the last part closes the company, its token revoked (every call refused, 401) and its addresses kept. `stop()` stops the host's runtime as a quiet spell would. A repository part is `<owner>/<slug>` (`owner`, `sanoma-test` by default); a slug in `taken` is someone else's, which `cloud-available` says and a sign-up or a rename refuses; an invite is a made-up link on the host's address. Its agent boxes run on this machine: each box's home a temporary directory and Sanoma's runner started in it on loopback (so `sandbox()`, `cloud.sandbox`'s backend over the fake, passes the Sandbox kit), named `<company id>/<name>`, each link a loopback URL with a made-up token; a stop keeps the runner, as a sleep keeps memory, and a discard, or the company's close, ends it and deletes the home. It refuses a name or hosts the Cloud would (`BOX_INPUTS`), keeps the company to 5 boxes, 2 awake, and to `awakeBoxes` awake in all when given, refusing one more with `BOXES_BUSY`; a runner that does not end in 5 s is killed, and a test process that exits without `close()` ends the runners and deletes their homes. It refuses what the workflows refuse, an id that is not the token's company's among them.

## Testing

`pnpm vitest run connectors/sanoma-cloud`, with Postgres from `pnpm db:up` and the runner built (`pnpm build`): the driver against a stand-in for the api, the Host and Database kits over the fake, and the Sandbox kit over the fake's boxes.

## Logo

`logo.svg` is a plain cloud drawn for this package: Sanoma has no published mark yet.
