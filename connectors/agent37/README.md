# @sanoma-ai/connector-agent37

[Agent37 Cloud](https://www.agent37.com) for [`@sanoma-ai/workflows`](https://www.npmjs.com/package/@sanoma-ai/workflows): the boxes a coding agent works in, one persistent Linux computer (an Agent37 instance) per box, which sleeps with its memory kept between turns. Agent37 has no SDK, so the connector calls its API with `fetch`, and drives a box through Sanoma's runner, which it starts in the box.

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

| Field    | What it is                                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `size`   | Optional: each box's vCPUs, `2` (the default) or `4`.                                                                                                                                      |
| `memory` | Optional: each box's memory in GB, `4` with 2 vCPUs, and `8` (the default), `16` or `32` with 4: [Agent37's shapes](https://www.agent37.com/docs/agents-api/instance-sizing).              |
| `disk`   | Optional: each box's disk in GB, `10` by default; at most 12 with 2 vCPUs, and 20, 40 or 80 with 4 by memory.                                                                              |
| `image`  | Optional: the [template](https://www.agent37.com/docs/agents-api/templates) a box runs, `agent37-base` by default (Linux with Node, Python, git and build tools), or a workspace template. |
| `region` | Optional: `us` (the default), `eu` or `ap-south`. Only `us` runs the `default` type.                                                                                                       |
| `type`   | Optional: `default` (a gVisor container on shared CPU, the default), `vm` (a kernel of its own, 2.5 times the compute rate) or `performance` (cores held for it, 4 times).                 |

The app opens its coding agents' boxes there once one is declared: one box per person per company, named `sanoma-<company>-<person>`, opened for each turn of Claude Code, Pi or a person's own agent and put to sleep at its end. A live instance that declares none refuses those agents rather than run them inside itself, and says so; going live writes `export const box = agent37.instance({})` into `resources/sanoma/infra.ts` once `AGENT37_API_KEY` is stored (on the app's Connect page or this connector's page). A company declares one instance at most.

The declaration is a record: apply binds it without making anything at Agent37 (its read lists the workspace's instances, so it fails when the key does not work), and its state is that binding and `healthy`. A box is made from the shape declared when it is first opened; one that exists keeps its shape, and deleting the declaration leaves the boxes.

The instance type meets the [`Sandbox` contract](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#sandboxes) (`sandbox`): a box's files survive a stop (`snapshot`), a stopped box keeps its memory and processes (`pause`), and its ports are reachable from outside (`port`). It takes `image` and `size` from the declaration.

| Operation                                       | Effect  | What it does                                                                        |
| ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `agent37.instance.read`, `.import`, `.plan`     | `read`  | List the workspace's instances, to say the key works; plan the record.              |
| `agent37.instance.create`, `.update`, `.delete` | `write` | Apply's: bind the declaration once the key works, or forget it. Nothing at Agent37. |

The logo the app shows beside these operations is the mark from Agent37's site (`/logo.svg`), drawn in black and in white. It is there only to identify the service.

## Boxes

The connector's sandbox half (`withSetup(…, { sandbox })`, `agent37Backend`) opens a box by name:

- `open({ name, image, size })` finds the instance whose metadata holds `sanoma_box: <name>`, or makes one (its label the name, cut to Agent37's 60 characters with a hash), with auto-sleep after 15 idle minutes; starts it when stopped, wakes it when asleep (retrying `409 try_again` while a checkpoint is still being written), waits until it runs, and starts the runner in it unless it answers. All of it within 3 minutes.
- `run(command, { cwd, env, stdin, signal })` is `bash -c` started by the runner, in `cwd` under the home (`/home/node` on Agent37's templates, the instance's disk) with `env` over the runner's, in a process group of its own, so `kill` (and an abort) signals the command and what it started. Its stdin, stdout and stderr stream as they come.
- `read(path)` and `write(path, bytes, { mode })` go through the runner too; a relative path is under the home.
- `expose(port)` is `https://<id>-<port>.agent37.app`, with the key as the `X-Agent37-Key` header, which Agent37's edge asks for.
- `stop()` kills the commands still running, closes the connection and puts the instance to sleep, the runner kept running in it, its memory checkpointed, or stops it (its disk kept) when the sleep is refused. `discard({ name })` deletes it.

The runner is [`@sanoma-ai/workflows`'s](https://github.com/Sanoma-AI/sanoma/blob/main/packages/workflows/README.md#sandboxes), one file, which `open` writes into a box with Agent37's exec when it does not answer (`~/.sanoma/runner.cjs`, gzipped through exec's body of 128 KB) and starts with the box's `node` (22 or later), as the image's user. It listens on port 7700, which `open` reaches over one WebSocket at `https://<id>-7700.agent37.app` with the key in `X-Agent37-Key`: Agent37's edge checks the key on every request to the port, the upgrade too, and the port is never made public, so the runner asks no credential of its own. Agent37's own exec is buffered and takes no stdin, which an agent's process needs; the runner streams both ways. A box that slept keeps the runner running; one that was stopped boots without it, and the next `open` starts it again (its log is `~/.sanoma/runner.log`). A runner that answers another release's protocol is replaced (ended by the pid its health answers, at `/runner/health`: Agent37's edge answers `/health` itself on every port), and what it started ends with it; one that does not answer is never killed. A custom template needs `node`, `bash`, `base64` and `gunzip`, as Agent37's templates have.

### What it costs

Agent37 meters per minute from a prepaid wallet: a `default` box costs $0.80 per vCPU-month and $0.70 per GB-month of memory while it is awake, and its disk $0.09 per GB-month in every state, so a 2 vCPU, 4 GB box with 10 GB awake for 300 hours a month costs about $2.71, and $0.90 a month asleep. A create needs one day of the box's rate in the wallet (`402 insufficient_balance`), and a workspace runs one instance before its first top-up, ten awake ones after.

## Driver

```ts
import { agent37 } from "@sanoma-ai/connector-agent37";
import { defineConfig } from "sanoma";

export default defineConfig({ workflows, connectors: [agent37] });
```

`./driver` (`agent37Driver`; `agent37Driver({ timeoutMs })`, 30 s by default) and `./fake` (`fakeAgent37`) are internal entries, for tests.

### Environment

| Variable          | What it is                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AGENT37_API_KEY` | A workspace's API key (`sk_live_…`), from Agent37's [Cloud API keys page](https://www.agent37.com/dashboard/cloud/api-keys). |

The driver reads it from the environment at each call; the sandbox half reads it through the app's secrets (the environment's first, then the one set on the connector page) at each `open`.

### Errors and retries

A failure is a `DriverError` with Agent37's status and its error's `code` as `vendorCode` (an object's `code` from the API, a flat string from its edge). 408, 429, 5xx, no reply and `try_again` are retryable; a refused key (`invalid_api_key`), an empty wallet (`insufficient_balance`), a shape the plan lacks (`tier_limit`) and the instance limit (`instance_limit_reached`) are not.

### Testing the driver

`test/driver.test.ts` replays Agent37's replies (`test/fixtures`) with [`@sanoma-ai/testing/replay`](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#replaying-a-vendors-api). The fixtures were written from Agent37's documentation, not recorded; `SANOMA_LIVE=1 SANOMA_RECORD=1 AGENT37_API_KEY=... pnpm vitest run connectors/agent37/test/driver.test.ts` records them.

`test/backend.test.ts` runs the [sandbox conformance kit](https://github.com/Sanoma-AI/sanoma/blob/main/packages/testing/README.md#a-sandboxs-conformance) and the backend's own cases against Agent37 on this machine (`test/vendor.ts`): its API from memory and its exec run here, so the runner the backend writes in and starts, its connection and the commands are the real ones.

### Running it live

`test/live.ts`, run by hand, makes a box on the key's wallet, writes a company repo's bundle into it, clones it and runs `pnpm install --frozen-lockfile`, puts it to sleep and wakes it, printing how long each took, then runs the conformance kit, and deletes what it made:

```sh
pnpm build
SANOMA_LIVE=1 AGENT37_API_KEY=sk_live_... node connectors/agent37/test/live.ts ../company-template
```

## Testing

`@sanoma-ai/connector-agent37/fake` is the fake the connector carries: an Agent37 whose key works and which holds no instances, so the instance type's operations answer at once. It opens no boxes; the testing package's `fakeSandbox` does, on this machine.

License: FSL-1.1-ALv2.
