---
title: Hosts, databases and sandboxes
description: "Resource contracts for running a company, waking an idle worker, provisioning a database, and providing a coding sandbox."
sidebar:
  order: 2
---

## Hosts

A host is a writable resource that runs the company, such as a container, a Render service, or a Fly app. Use `defineResource({ …, writable: true, host })`. The `host` contract (`HostSpec`) maps input names to dotted paths in the resource’s fields.

| Host field | Contract |
| --- | --- |
| `inputs` | Maps `source`, `ref`, `secrets`, and `port`. A host can also accept `domains` and `hostname`. Each mapping must name an existing field. The `secrets` field must be write-only. |
| `domains` | Maps public site names to domains. The host passes them to the app as `SANOMA_DOMAINS`. `describeConfig` reports a nonpublic site or a shared domain at the declaration, for example `sanoma.example is the domain of both www and docs`. |
| `hostname` | The app’s own hostname. It must differ from all site domains and other hostnames. With it, the host reports `https://<hostname>` as `url` and the vendor URL as `wakeUrl`. A wake can reach the vendor while the custom domain’s DNS or certificate is pending. Without a hostname, `url` is the vendor URL. `wakeUrlOf(outputs)` falls back to `url`. |
| `router` and `agents` | Where supported, apply fills `router` with the configured [router hostname](/start/agents-over-mcp/#a-router-one-mcp-for-many-companies). To put a company behind a router, set `agents` to `{ url, company }` (`routedAgentsSchema`). `cloudflare.host` supports both fields. |
| `revision` | Apply fills this field with the resolved commit. A data file names the branch. |
| `capabilities` | Describes `lifetime`, `publicUrl`, `buildsFromGit`, and `staticEgress`. The `HostLifetime` is `long-lived` or `stops-on-exit`. With `stops-on-exit`, the process exits when the worker goes idle and the host starts the instance again on a wake. |
| `outputs(state)` | Returns `{ url, wakeUrl?, revision?, healthy }`. |

### Bootstrap credentials

A host whose vendor mints the instance's bootstrap (its database URL, keys and tokens) and binds it itself declares `bindsBootstrap: true` and takes no `secrets` (Sanoma Cloud's `cloud.host`); `defineResource` refuses one that gives both, or neither. Such a host may name its vendor's `account` operations by id (`account: { repository, available, invite }`: the company's repository made there, whether an address is free, a sign-in link on the host), which going live from a computer calls; `defineResource` refuses an `account` on a host that does not bind its own bootstrap.

A write-only field may be a map of secrets (`secrets: { SANOMA_DATABASE_URL: secret("DATABASE_URL") }`): its markers are kept as one at the field is. A host type is `stateless` (a `ResourceSpec` field, default true for a host): its objects keep no data, so replacing or recreating one is routine. `source` is a clone URL, or a reference to a declared repository with a `by` field holding one.

### Deriving a host from its repository

For a host with `derives: true`, such as `cloudflare.host` or `cloud.host`, declare the choices specific to the company: its `name`, `hostname`, and `database`. The `inputs.database` field is a write-only reference to the declared database. In the data-file step, `deriveHosts` uses `hostFacts` to fill in the revision and the remaining inputs before planning.

| Input | How apply determines it |
| --- | --- |
| `name` | For a type with `inputs.name`, use its bound name when available so a repository rename preserves the host. Otherwise use the repo name normalized to lowercase letters, digits, and dashes. Until the name resolves, the identity is `UNNAMED`. |
| `image` | For a type that accepts it, use the installed Sanoma version’s runtime image, `runtimeImage(version)` or `ghcr.io/sanoma-ai/runtime:<version>` (`RUNTIME_IMAGE`). |
| `source` and `ref` | Use the declared repository matching `origin`, then the one identified by `sourceRepository`, then the credential-free `origin` URL (`originUrl`, `cloneUrl`). Resolve the default branch to obtain the revision. |
| `domains` and `router` | Read `domain` from each public site’s `defineSite({ public: true, domain })`. Use the config’s `router.hostname` for a host with `inputs.router`. |
| `port` | Use the image port (`RUNTIME_PORT`). |

You can override `image`, `source`, and `ref`. Declaring `port`, `secrets`, `domains`, or the router hostname directly on the derived host is invalid.

A host that accepts derived bootstrap receives secret references. Apply supplies these bindings when they apply to the host:

- `SANOMA_DATABASE_URL` comes from `databaseUrlSecret` for the database export.
- `SANOMA_SIGNING_KEY` comes from the config’s `{ env }` or `{ bootstrap }` binding, or from `secret("SANOMA_HOST_SIGNING_KEY", { generate: true })` (`HOST_SIGNING_KEY`), generated in the store when the host is created. Built-in secret storage also requires a bound `SANOMA_SECRETS_KEY` because the store cannot supply its own unlock key.
- A GitHub repo uses `SANOMA_SOURCE_KEY` when the config has the `github.repository_deploy_key` type. Without that type, HTTPS cloning requires a public repo.
- A wakeup that names the host supplies its token and, for `sanoma.wakeup`, its URL. A router host needs its master `SANOMA_ROUTER_SECRET` (`ROUTER_SECRET`). A host with `agents` needs its company-specific secret for the router.
- Apply includes the environment variables read by vendor drivers in the data file and by the login sender, including optional values once stored. It also includes stored GitHub App keys from `GITHUB_APP`, the list used by staff login and the Connect page.

A live apply generates missing source and wakeup credentials. It stores the private half of the source key pair as `SANOMA_SOURCE_KEY` when the deploy-key type exists. The wakeup token starts with `swi_`.

For a GitHub repository, apply then declares the deploy key itself, `<file>#host.sourceKey` (`sourceKeyId`), a read-only `github.repository_deploy_key` of the key's public half, before the host, with its type's identity (`<owner>/<repository>:<key>`), so a key GitHub holds already is bound, never made again (GitHub takes a key once).

### When a host is left out of the plan

Apply omits a host with unresolved inputs and anything that depends on it, including its wakeup. Check the reported declaration for these conditions.

- **Missing input.** Supply a `database`, an `image` if Sanoma is not installed, and a `source` if the repo lacks an `origin`. The host must have a name that is unique for its type.
- **Unavailable credential.** A driver may read a local environment variable that the host cannot access. For `ACME_TOKEN is read from the environment here, and has no binding, …`, declare an `{ env }` binding in `sanoma.config.ts` or save the credential on the connector page. A [binding marked `host: true`](/reference/secret-stores/#secret-store-configuration) must also have a value where apply runs.
- **Private source.** A private GitHub repo needs a deploy-key type. `hostFacts` checks whether the repo from `origin` or the declared `source` is public using an unauthenticated request.
- **Conflicting routes.** Only one host can attach the sites’ domains. A config with a `router` needs one deriving host to serve it. Supply `SANOMA_ROUTER_SECRET` wherever apply must bind it. `routingProblems` reports a router hostname that collides with the host or site and a router host that also declares `agents`. The latter would give one binding two different secrets.

`describeConfig` reports those two as well, with another declared host's hostname or domain being the router's, and `routerWarnings` warns of a declared host whose type takes no router.

At plan time, a host whose state has domains attached while no site declares one is a problem too, with no step: a change would detach them (put `domain` on each site). Apply's `bind` of an object its identity found that an orphaned binding of the same type holds takes that binding over (`from` on the step, written in the same commit, `Apply: rebind … from …`): the orphan is none, as for an export renamed, or a deploy key a data file declared before (`#deployKey`) that apply now declares as `#host.sourceKey`.

A type renamed keeps its objects: `formerly` (a `ResourceSpec` field, `["cloudflare.container"]` on `cloudflare.host`) lists the ids whose lockfile bindings bind its declarations.

A config whose connectors declare a host type has the built-in operation `sanoma.source.resolve` (`SOURCE_RESOLVE`, effect `read`): `{ url, ref? } → { revision, ref }`, by `git ls-remote` on this machine (a branch, then a tag, peeled; a full commit id is itself; with no `ref`, the default branch its `HEAD` names, `defaultBranch(url)`).

Apply calls it for each host it plans, and gives the host the commit as its `revision` and the clone URL as its `source` (a referenced repository's, from its `by` field); a host whose ref does not resolve, or whose repository has no clone URL yet (apply the repository first), is a problem of the plan. The drift run calls it for every host it reads. A sandbox run calls its fake instead (`fakeSourceDriver`), with no git or network: a full commit id is itself, any other ref the SHA-1 of `<url>#<ref>`, the same on every run, and the default branch `main`.

A host's `secrets` map may name sanoma's own secrets (`SANOMA_…`), and no other field of any type may. `resolveRevision(url, ref)` is the same, outside a run.

## Wakeup resources

A wakeup is a resource type that starts a stopped instance at a time, for what is due while its host is stopped: `defineResource({ …, writable: true, wakeup })`, where `wakeup` (`WakeupSpec`) names the field that references the host (`inputs.host`), the type's own operation the runtime registers each deadline through (`register`, called with `{ at }`, which replaces whatever the wakeup held) and how its state reads (`outputs(state) → { healthy }`); `defineResource` and `resolveConfig` refuse one that does not meet it.

Declaring one in a data file is the switch, with no mode flag: `declaredWakeup(config)` reads it, and several are a problem of the data files.

A wake is `GET {url}/wake`, with no query: resume if stopped. A config with `wakeup: true` runs the wakeup service itself and must not stop, so `startWorker` refuses it beside a declared wakeup.

With none declared, a worker given `onStopped` takes the wakeup its environment names (`envWakeup(process.env)`, an `EnvWakeup` of `{ url, token }` when both `SANOMA_HOST_URL` (`HOST_URL`, an http(s) URL as the wakeup service keeps one) and `SANOMA_WAKEUP_TOKEN` are set, as a host Sanoma Cloud made sets them) and registers each deadline itself: `PUT {url}/__sanoma/wake` (`WAKE_PATH`) with the token as a bearer and `{ at }`, answered 204, no driver.

An instance with `wakeup: true` ignores it.

A config whose connectors declare a host type also has the runtime's own wakeup, `sanoma.wakeup({ host })` (`import { sanoma } from "sanoma/resources"` in a data file), no connector named: an instance of a [wakeup service](#the-wakeup-service) for a `cloudflare.host`, `cloudflare.container`, `docker.container` or `testhost.app`, the fallback for a host with no clock of its own (a host's own vendor's wakeup comes first).

Its driver creates, reads and deletes the instance at `SANOMA_WAKEUP_URL` with the account's `SANOMA_WAKEUP_ACCOUNT_TOKEN`, registering the instance's own `SANOMA_WAKEUP_TOKEN`, and `sanoma.wakeup.register` sends `PUT {url}/wakeup/wake { at }` with that token; `fakeSanomaWakeup()` from `sanoma/workflows/fake` is the service in memory, which sends `GET {host}/wake` at `at`.

### When the worker stops

A worker whose data files declare a wakeup, started with `onStopped` (whoever starts the next one; without it the worker never stops), stops itself when nothing it would run can run soon.

Every 15 s (`stopCheckMs`) it asks `worker.idle()`: no run is executing or replaying; none of its version is queued, on its queue or on DBOS's own, where recovery puts runs; every unfinished run of its version is blocked in a `ctx.sleep` or a `ctx.approval`; and the next deadline (the earliest sleep's end, or a source added with `worker.deadlines.addSource`, such as a schedule's next fire) is more than `idleHorizonMs` away (60 s), so short waits never stop it.

An approval has no deadline: its decision comes from a request, which starts the worker. Runs of another version or queue are not this worker's and never keep it up.

The worker registers the next deadline through the wakeup type's `register` (`{ at }` as the agent `wakeup`, idempotency key `wakeup:<binding or declaration id>:<uuid>`, fresh per registration so a repeated `at` re-arms, no ledger record), replacing what the wakeup held, records `at` and `stopped_at` on the `sanoma_wakeup` row, stops, and calls `onStopped({ at })`; with no deadline at all it registers nothing.

A stop that is not its own (`worker.stop({ register: true })`, as `sanoma worker` stops on a signal) first registers what the next worker must do: now when it is not idle (a run under way, queued or due within the horizon), else its next deadline. A failed registration is recorded as `last_error` and logged, and the worker keeps running and tries again at the next check.

A stopped worker cannot launch again in its process, so whoever supervises it starts a fresh `startWorker(config)` on the next request, or when the wakeup calls `GET /wake`. A wake that arrives for a registration replaced since starts at most a worker with nothing to do soon, which stops again.

`superviseWorker(config, options)` is that supervisor, as `sanoma serve` and `sanoma worker` run it: one worker at a time, started with `onStopped` (its own `onStopped` hears each stop; `selfStop: false` gives none, so the worker never stops itself), and `wake()`, for a write that needs a worker (once it committed) and for the wakeup's `GET /wake` alike, asks for a worker that looks at the database after that moment: a fresh one once the last stopped itself, and, for a wake heard while one starts or runs, a fresh one at once after that one stops itself (whose checks may have run before the write committed), so `onStopped` finds `stopped` false.

`onEnded` hears each time it is left with no worker: a stop with no wake heard, or a fresh worker that failed to start. `sanoma worker` on a host that starts it again (its environment names the host's wake route) exits then, 0 or, for a failed start, 1, so a host that `stops-on-exit` ends the instance with it. `SanomaClient.connect(config, { onWrite })` calls `onWrite` right after each change a worker must run commits (a start, drift, apply and a held call among them, and a decision), never for a read: the app passes it, to wake its process's worker or its host's.

Apply gives a declared wakeup its host's URL: its `inputs.host` field holds what the host's `outputs(state)` says (its `wakeUrl`, else its `url`), from the host's state found in the run or made by it, where any other reference resolved `by` holds the binding id. The row holds `at`, the deadline last registered (null until one is), `stopped_at` and `last_error`.

Every start costs each unfinished run of its version one of DBOS's recovery attempts, so the runtime raises them from DBOS's 100 to 100,000; and a `ctx.sleep` for a duration takes its start from DBOS's clock, so a recovered run keeps the deadline it registered.

## The wakeup service

`startWakeupService({ databaseUrl, now?, fetch?, log? })` from `sanoma/workflows/wakeup-service` (server-side only, refused in workflow files like `/scenario`) is the service a wakeup type registers with: `sanoma wakeup` runs it, and `sanoma serve` does with `wakeup: true` ([the sanoma package](/hosting/wakeup/) says how an instance registers).

It makes its two tables in `databaseUrl` (and the database, when missing) and returns `{ routes, mintAccount(label), revokeAccount(id), stop() }`: `routes` is one route answering everything under `/wakeup` (a body over 64 KiB is a 413), the shape of the app's `IngressRoute` with `prefix`, for `startApp`'s `ingress` or a server of your own; `mintAccount` returns `{ id, token }`, the token shown that once; `revokeAccount` refuses the account's token and its instances' and wakes them no more.

One loop sleeps until the next registered `at` (at most 60 s, or until a `PUT` takes a registration), takes each due instance for 30 s (so two services on one database never call it twice), calls its `GET {url}/wake` with a 10 s timeout, eight at a time, and on anything but a 2xx (a redirect, which it never follows, among them) tries again after `min(2^attempts s, 5 min)`, never giving up. Each `PUT` replaces what the instance registered before, and a registration replaced during its call is called again.

`stop` ends the loop, abandoning the calls in flight (called again once their 30 s lapse), and closes its pool. `mintWakeupAccount(databaseUrl, label)` mints an account without starting the service, for `sanoma wakeup account`. The service never mints an instance's token: `mintInstanceToken()` makes one (`swi_…`) for the company to keep, which it registers with `POST /wakeup/instances { url, token }`. `now` and `fetch` are for tests; `log` takes an `info` line per call and a `warn` per failure (the runtime's logger by default).

## Databases

A database is a resource type that holds the company's database (a Neon project, a Supabase project): `defineResource({ …, writable: true, afterCreate, database })`, where `database` (`DatabaseSpec`) says what it can do (`capabilities: { pauses, branch }`: its compute scales to zero and wakes on a connection; it makes copy-on-write branches that carry the data), where it takes going live's choices, by dotted path into its fields (`inputs: { region, size? }`), the regions it takes when known (`regions`), the operation that stores its URL (`storeUrl`) and how its state reads (`outputs(state) → { healthy }`).

`storeUrl` is an operation of the type's own vendor, in the type's own group (`neon.project.storeUrl`) or another (`supabase.database.storeUrl`), never one of a resource type's own: it takes `{ ref | id, export }` and stores the URL that carries `LISTEN` as `SANOMA_DATABASE_URL_<EXPORT>` (`databaseUrlSecret(export)`; `storeDatabaseUrl` stores it so, refusing a secret that holds another), never returning it, and the type's `afterCreate` calls it.

A database type is not `stateless`: apply asks before it deletes one. `defineResource` refuses a `database` that breaks any of that; `resolveConfig` refuses one whose `storeUrl` is not among the config's operations, or does not take a binding id and an export. Its conformance kit is [`sanoma/testing/database`](/testing/conformance/#a-databases-conformance). After retiring a database, a workflow can remove its exported URL with `sanoma.secret.delete` under the [runtime operation contract](/workflows/built-ins/#the-runtimes-own-operations).

`databaseUrlSecret` converts camel-case exports to uppercase words (`mainStore` → `SANOMA_DATABASE_URL_MAIN_STORE`) and preserves exports that are already uppercase, including digits and underscores (`CLOUD_ACME_97F9` → `SANOMA_DATABASE_URL_CLOUD_ACME_97F9`). Use the same export when storing, binding and retiring its URL.

## Sandboxes

A sandbox is a resource type whose boxes a coding agent works in (an Agent37 instance): `defineResource({ …, writable: true, sandbox })`, where `sandbox` (`SandboxSpec`) says what its boxes can do (`capabilities: { snapshot, pause, port }`: their files survive a stop; a stopped box keeps its memory; a port is reachable from outside), where it takes a box's image and its size in vCPUs, by dotted path into its fields (`inputs: { image?, size? }`; one it leaves out is the vendor's choice, as Sanoma Cloud's both are), and how its state reads (`outputs(state) → { id, healthy }`).

The vendor's own facts (region, machine type) are fields of the resource, never the environment.

Its connector attaches the backend (`withSetup(connector, { sandbox: ({ secrets, declared }) => backend })`, `declared` the declared resource's fields, where the vendor's facts are): `open({ name, image, size, hosts })` gives the box `name`, made, woken or started as it needs, reaching only `hosts` over HTTPS (the registry and every installed coding agent's, a box made with others set to them), and `discard({ name })` deletes it and all the vendor kept.

A `Box` runs `bash -c` (`run(command, { cwd, env, stdin, signal })` → a `Process` of web streams, `wait()` and `kill()`), reads and writes files (a relative path is under its home), exposes a port (`expose(port)` → `{ url }`, any credential in the URL, such as a signed link's token) and stops. `localBackend(dir, env?)` is the backend on this machine: a box is the directory `<dir>/<name>`, its commands children in process groups of their own (`LOCAL_SANDBOX`: it snapshots and exposes ports on loopback).

### The sandbox runner

A remote box is driven through the runner, a small server of Sanoma's that its backend starts inside it: `runnerScript()` is the runner as one file (Node 22 or later, nothing to install), which listens on `RUNNER_PORT` (7700), answers `GET /runner/health` (`RUNNER_HEALTH`) with its protocol and pid (`RunnerHealth`, `{ protocol, pid }`, `RUNNER_PROTOCOL`; `runnerHealth(url)` asks it) and asks no credential, since the vendor's edge authenticates every request to the port, by a credential in the URL; `runnerBox({ url, id, sleep? })` is the box's `run`, `read`, `write` and `stop` over one WebSocket to it, its commands streaming both ways, which a vendor's buffered exec cannot.

Its `url` is a function it asks at each connect, so a vendor whose link expires hands a new one at the next reconnect; its `stop` kills what runs in the box, then calls `sleep`.

`ResolvedConfig.sandboxes()` gives the declared one, read at each call (an instance opens its coding agents' boxes in one sandbox: several are each a problem of the data files, and left out), and `sandboxBackends` the makers of the backends the connectors attach, by vendor: the app (`personBox`) makes the declared one's vendor's with its fields and opens a person's box in it, falls back to `localBackend` on this computer behind the loopback login (which enforces no `hosts`), and refuses its coding agents on a live instance, or one people sign in to, that declares none.

`open`'s `image` and `size`, left out, are the backend's own. `defineResource` refuses a `sandbox` that breaks any of that. Its conformance kit is [`sanoma/testing/sandbox`](/testing/conformance/#a-sandboxs-conformance).
