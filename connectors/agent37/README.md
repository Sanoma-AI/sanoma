# @sanoma-ai/connector-agent37

[Agent37 Cloud](https://www.agent37.com) for [`sanoma/workflows`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md): the boxes a coding agent works in, one persistent Linux computer (an Agent37 instance) per box, which sleeps with its memory kept between turns. Agent37 has no SDK, so the connector calls its API with `fetch`, and drives a box through Sanoma's runner, which it starts in the box.

## Usage

```sh
npm install @sanoma-ai/connector-agent37
```

A data file declares the boxes; nothing is made until someone's first turn opens one:

```ts
// resources/sanoma/infra.ts
import { agent37 } from "@sanoma-ai/connector-agent37/resources";

export const box = agent37.instance({ size: 2 });
```

| Field    | What it is                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `size`   | Optional: each box's vCPUs, `2` (the default) or `4`.                                                                                                                                                                                                                                                                                                               |
| `memory` | Optional: each box's memory in GB, `4` with 2 vCPUs, and `8` (the default), `16` or `32` with 4: [Agent37's shapes](https://www.agent37.com/docs/agents-api/instance-sizing).                                                                                                                                                                                       |
| `disk`   | Optional: each box's disk in GB, `10` by default; at most 12 with 2 vCPUs, and 20, 40 or 80 with 4 by memory.                                                                                                                                                                                                                                                       |
| `image`  | Optional: the [template](https://www.agent37.com/docs/agents-api/templates) a box runs. By default Sanoma's box image of the installed `sanoma` ([below](#the-box-image)); `agent37-base` (Linux with Node, Python, git and build tools), or another workspace template, which needs `node` (22 or later), `bash`, `git`, `base64`, `gunzip`, and pnpm or corepack. |
| `region` | Optional: `us` (the default), `eu` or `ap-south`. Only `us` runs the `default` type.                                                                                                                                                                                                                                                                                |
| `type`   | Optional: `default` (a gVisor container on shared CPU, the default), `vm` (a kernel of its own, 2.5 times the compute rate) or `performance` (cores held for it, 4 times).                                                                                                                                                                                          |

The app opens its coding agents' boxes there once one is declared: one box per person per company, named `sanoma-<company>-<person>`, opened for each turn of Claude Code, Pi or a person's own agent and put to sleep at its end. A live instance that declares none refuses those agents rather than run them inside itself, and says so; going live writes `export const box = agent37.instance({})` into `resources/sanoma/infra.ts` once `AGENT37_API_KEY` is stored (on the app's Connect page or this connector's page). A company declares one instance at most.

The declaration is a record: apply binds it without making anything at Agent37 (its read lists the workspace's instances, so it fails when the key does not work), and its state is that binding and `healthy`. A box is made from the shape declared when it is first opened; one that exists keeps its shape, and deleting the declaration leaves the boxes.

The instance type meets the [`Sandbox` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#sandboxes) (`sandbox`): a box's files survive a stop (`snapshot`), a stopped box keeps its memory and processes (`pause`), and its ports are reachable from outside (`port`). It takes `image` and `size` from the declaration.

| Operation                                       | Effect   | What it does                                                                                            |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `agent37.instance.read`, `.import`, `.plan`     | `read`   | List the workspace's instances, to say the key works; plan the record.                                  |
| `agent37.instance.create`, `.update`, `.delete` | `write`  | Apply's: bind the declaration once the key works, or forget it. Nothing at Agent37.                     |
| `agent37.box.open`, `.expose`                   | `access` | Open a box and mint a signed link to its runner, or to another of its ports ([below](#box-operations)). |
| `agent37.box.sleep`, `.discard`                 | `write`  | Put a box to sleep; delete a box, or every box of a group.                                              |
| `agent37.box.list`                              | `read`   | A group's boxes, and whether each is awake.                                                             |

The logo the app shows beside these operations is the mark from Agent37's site (`/logo.svg`), drawn in black and in white. It is there only to identify the service.

## Boxes

The connector's sandbox half (`withSetup(…, { sandbox })`, `agent37Backend`) opens a box by name:

- `open({ name, image, size, hosts })` finds the instance whose metadata holds `sanoma_box: <name>`, or makes one from `image` (else [the box image](#the-box-image); its label the name, cut to Agent37's 60 characters with a hash), with auto-sleep after 15 idle minutes and [network access](https://www.agent37.com/docs/agents-api/instance-network.md) limited to `hosts` (`network: { allow: hosts }`: HTTPS to those names, nothing else). An instance found with any other network (one made before the allowlist reaches anywhere, `allow-all`) is set to `hosts` in place with `PATCH /v1/instances/{id}` before it is woken, its disk and memory kept (sent again while Agent37 answers `503 try_again`). The allowlist limits only what the box dials: the app's connection to the runner, and to an exposed port, come in through Agent37's edge. Then it starts the instance when stopped, wakes it when asleep (retrying `409 try_again` while a checkpoint is still being written), waits until it runs, and starts the runner in it unless it answers. Then, at every open, it puts pnpm on the box's `PATH` with Agent37's exec unless it is there, which the coding agents' installs run and Agent37's templates lack: `corepack enable --install-directory ~/.local/bin pnpm` (the templates put `~/.local/bin` first on their `PATH`); when that fails, the open fails with `pnpm could not be put in the box` and what corepack said. All of it within 3 minutes.
- `run(command, { cwd, env, stdin, signal })` is `bash -c` started by the runner, in `cwd` under the home (`/home/node` on Agent37's templates, the instance's disk) with `env` over the runner's, in a process group of its own, so `kill` (and an abort) signals the command and what it started. Its stdin, stdout and stderr stream as they come.
- `read(path)` and `write(path, bytes, { mode })` go through the runner too; a relative path is under the home.
- `expose(port)` is `https://<id>-<port>.agent37.app`, with the key as the `X-Agent37-Key` header, which Agent37's edge asks for.
- `stop()` kills the commands still running, closes the connection and puts the instance to sleep, the runner kept running in it, its memory checkpointed, or stops it (its disk kept) when the sleep is refused. `discard({ name })` deletes it.

The runner is [`sanoma/workflows`'s](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/workflows/README.md#sandboxes), one file, which `open` writes into a box with Agent37's exec when it does not answer (`~/.sanoma/runner.cjs`, gzipped through exec's body of 128 KB) and starts with the box's `node` (22 or later), as the image's user. It listens on port 7700, which `open` reaches over one WebSocket at `https://<id>-7700.agent37.app` with the key in `X-Agent37-Key`: Agent37's edge checks the key on every request to the port, the upgrade too, and the port is never made public, so the runner asks no credential of its own. Agent37's own exec is buffered and takes no stdin, which an agent's process needs; the runner streams both ways. A box that slept keeps the runner running; one that was stopped boots without it, and the next `open` starts it again (its log is `~/.sanoma/runner.log`). A runner that answers another release's protocol is replaced (ended by the pid its health answers, at `/runner/health`: Agent37's edge answers `/health` itself on every port), and what it started ends with it; one that does not answer is never killed.

### Box operations

The `box` operations open the same boxes for a caller that holds the key on behalf of one that must not: Sanoma's control plane, for a company's own instance on Sanoma Cloud. Each open or expose hands back a signed link, which reaches one port of the box with no key, so the key never leaves the caller; the company's instance talks to the runner over the link itself (`runnerBox({ url, id })`, no headers).

- `box.open({ name, group, network?, ttl })` opens the box as the sandbox half's `open` does, over Agent37's API and exec, so it holds no connection that would keep the box awake. A box of that name in another group, or in none, is refused with `409` `other_group`, so a group's operations never reach a box outside it. A new box is made from the box image, labelled `sanoma_group: <group>` beside its name, and limited to the domains and addresses in `network` (up to 100; anywhere when left out); a box that exists is set to `network` in place when it has another, and keeps its own when `network` is left out. It answers the box's `id`, a signed link `url` to the runner's port 7700 for `ttl` seconds with its `expiresAt`, and the runner's `protocol`, which the caller's own `sanoma` must speak.
- `box.expose({ name, port, ttl })` mints a link to another port of the box, such as an agent's bridge; `not_found` when there is no such box.
- `box.sleep({ name })` puts the box to sleep, its memory kept; `box.discard({ name })` deletes it, and `box.discard({ group })` deletes every box of the group and no other. Each answers the instances it acted on.
- `box.list({ group })` answers the group's boxes, `{ id, name, awake }`, a box being awake when it is neither asleep, stopped nor failed: the awake ones count toward the workspace's limit.

A link's token rides in its `a37_token` parameter, which Agent37's edge takes in place of the key and strips before the request reaches the box. It opens one port of one instance, for 60 seconds to 7 days, and cannot be revoked before it expires: a connection opened before then stays up after, and new requests after it get `401`. It never authorizes exec. The ledger records that an open or expose minted a link, never the link (`opaque`).

When the workspace already runs as many awake instances as its limit allows, `box.open` fails with `409` and the `vendorCode` `instance_limit_reached`, not retried, so the caller can say so in its own words.

Opens of one name in one process wait for each other, so a retry finds the box the first made, and a `box.discard({ name })` waits for them. Agent37 does not read metadata, so two opens of one name at once in two processes can each make a box: the caller runs one open of a name at a time. `box.discard({ name })` removes every box of the name.

Every box carries Agent37's `AGENT37_MANAGED_TOKEN` in its environment, which spends the workspace's wallet on Agent37's managed model and tools within the box's budget. That budget defaults to 0, and the connector never raises it: it must stay 0, since the box runs a person's own agent on their own plan.

### The box image

With no `image` declared, a new box is made from [Sanoma's box image](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/README.md#the-box-image), `ghcr.io/sanoma-ai/box:<version>` of the `sanoma` the connector is installed beside, which carries each connector's own coding agent installed, so a person's first turn waits for no install. Agent37 makes an instance from a template of the workspace, never from an image, so before it makes a box `open` asks for the workspace's template `sanoma-box-<version>` (the version's dots as dashes) and, when there is none, registers the image as it (`POST /v1/templates`: Agent37 copies the public image once, which can take minutes, given up to 5 apart from `open`'s 3; a `409 template_conflict` means it is there). Opens at once share one registration, and each new box after asks again, so a template deleted in Agent37's dashboard is registered again. When the template cannot be had, a warning says why and the box is made from `agent37-base`, which works as before, only slower to its first turn. A declared `image` is used as it is, and a box that exists keeps the image it was made from.

### What it costs

Agent37 meters per minute from a prepaid wallet: a `default` box costs $0.80 per vCPU-month and $0.70 per GB-month of memory while it is awake, and its disk $0.09 per GB-month in every state, so a 2 vCPU, 4 GB box with 10 GB awake for 300 hours a month costs about $2.71, and $0.90 a month asleep. A create needs one day of the box's rate in the wallet (`402 insufficient_balance`), and a workspace runs one instance before its first top-up, ten awake ones after.

## Driver

```ts
import { agent37 } from "@sanoma-ai/connector-agent37";
import { defineConfig } from "sanoma";

export default defineConfig({ workflows, connectors: [agent37] });
```

`./driver` (`agent37Driver`; `agent37Driver({ timeoutMs, edge, budgetMs })`, 30 s per request and 3 minutes for a box by default) and `./fake` (`fakeAgent37`) are internal entries, for tests.

### Environment

| Variable          | What it is                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AGENT37_API_KEY` | A workspace's API key (`sk_live_…`), from Agent37's [Cloud API keys page](https://www.agent37.com/dashboard/cloud/api-keys). |

The driver reads it from the environment at each call; the sandbox half reads it through the app's secrets (the environment's first, then the one set on the connector page) at each `open`.

### Errors and retries

A failure is a `DriverError` with Agent37's status and its error's `code` as `vendorCode` (an object's `code` from the API, a flat string from its edge). 408, 429, 5xx, no reply and `try_again` are retryable; a refused key (`invalid_api_key`), an empty wallet (`insufficient_balance`), a shape the plan lacks (`tier_limit`) and the instance limit (`instance_limit_reached`) are not.

### Testing the driver

`test/driver.test.ts` replays Agent37's replies (`test/fixtures`) with [`sanoma/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/testing/README.md#replaying-a-vendors-api). The fixtures were written from Agent37's documentation, not recorded; `SANOMA_LIVE=1 SANOMA_RECORD=1 AGENT37_API_KEY=... pnpm vitest run connectors/agent37/test/driver.test.ts` records them.

`test/box.test.ts` runs the box operations against the same Agent37 on this machine, whose edge takes a signed link's token in place of the key.

`test/backend.test.ts` runs the [sandbox conformance kit](https://github.com/Sanoma-AI/sanoma/blob/main/packages/sanoma/testing/README.md#a-sandboxs-conformance) and the backend's own cases against Agent37 on this machine (`test/vendor.ts`): its API from memory and its exec run here, so the runner the backend writes in and starts, its connection and the commands are the real ones.

### Running it live

`test/live.ts`, run by hand, makes a box on the key's wallet, writes a company repo's bundle into it, clones it and runs `pnpm install --frozen-lockfile`, puts it to sleep and wakes it, printing how long each took, then runs the conformance kit, and deletes what it made:

```sh
pnpm build
SANOMA_LIVE=1 AGENT37_API_KEY=sk_live_... node connectors/agent37/test/live.ts ../company-template
```

Its boxes run `agent37-base`; `AGENT37_TEST_IMAGE` names another template of the workspace, such as the box image's (`sanoma-box-<version>`).

## Testing

`@sanoma-ai/connector-agent37/fake` is the fake the connector carries: an Agent37 whose key works and which holds no instances, so the instance type's operations answer at once, and whose `box` operations keep boxes as records in memory (their links reach nothing). It opens no sandbox; the testing package's `fakeSandbox` does, on this machine.

License: FSL-1.1-ALv2.
