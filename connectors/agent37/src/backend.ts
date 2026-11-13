import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  DriverError,
  errorMessage,
  installedSanoma,
  RUNNER_PORT,
  RUNNER_PROTOCOL,
  runnerBox,
  runnerHealth,
  runnerScript,
  type SandboxBackend,
  type SandboxContext,
} from "sanoma/workflows";
import { slugged } from "sanoma/workflows/shared";
import { agent37Api, type Agent37Api, type Instance, isCode } from "./api.ts";
import { BASE, type Wanted, wanted } from "./connector.ts";
import { otherGroup } from "./operations.ts";

// The `Sandbox` backend on Agent37: a box is an instance, found by the name in its metadata,
// made when there is none (from Sanoma's box image unless an image is declared), woken or started
// when it sleeps or is stopped, and reaching only the hosts `open` is given (Agent37's `network`
// allowlist, set in place on one made with another). Its commands and files go through Sanoma's
// runner in it (`runnerBox`, at its port 7700 behind Agent37's edge, which the app dials: an
// allowlist limits only what the box dials out), which `open` starts there when it does not
// answer: Agent37's own exec is buffered and has no stdin, which an agent's process needs. Its
// ports are reached through the edge, and `stop` puts it to sleep, which keeps the runner running
// for the next `open`. The control plane's box operations (`driver.ts`) open a box the same way
// (`openInstance`), and hand back a signed link to its runner instead of a connection.

export const KEY = "AGENT37_API_KEY";

/** The metadata key a box's name is kept under: an instance's `name` is a label of 60 characters. */
export const BOX = "sanoma_box";

/** The metadata key a box's group is kept under, such as the company it is for (`box.open`). */
export const GROUP = "sanoma_group";

/** How long `open` and `stop` wait for an instance to be running, or asleep, in all. */
export const BUDGET_MS = 3 * 60_000;

/** Agent37's edge: where an instance's port is reached. */
export const EDGE = (id: string, port: number) => `https://${id}-${port}.agent37.app`;

/**
 * Sanoma's box image (`packages/sanoma/box`), tagged with each release's version: Node, git, pnpm
 * and the connectors' own coding agents installed. A box's image when none is declared.
 */
export const BOX_IMAGE = "ghcr.io/sanoma-ai/box";

/** How long registering the box image may take: Agent37 copies it before it answers. Not `open`'s budget. */
const TEMPLATE_MS = 5 * 60_000;

/** Agent37's longest instance label. */
const LABEL = 60;

/** An instance's label for the box `name`: the name, or when it is longer, its start and a hash of it. */
export function labelOf(name: string): string {
  if (name.length <= LABEL) return name;
  return `${name.slice(0, LABEL - 11)}-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
}

export interface Agent37BackendOptions {
  /** Where an instance's port is reached: Agent37's edge, `https://{id}-{port}.agent37.app`. */
  edge?: (id: string, port: number) => string;
  /** How long `open` waits for a box, and `stop` for its sleep. Default 3 minutes. */
  budgetMs?: number;
}

/**
 * Agent37's boxes with the key `AGENT37_API_KEY`, read at each `open`, of the shape `declared`
 * (an `agent37.instance`'s fields) with `open`'s image and size.
 */
export function agent37Backend(
  { secrets, declared }: SandboxContext,
  { edge = EDGE, budgetMs = BUDGET_MS }: Agent37BackendOptions = {},
): SandboxBackend {
  const keyOf = async () => {
    const key = (await secrets([KEY])).get(KEY);
    if (!key) throw new Error(`agent37 is not configured: ${KEY} is not set; set it on the connector page`);
    return key;
  };
  return {
    async open({ name, image, size, hosts }) {
      const key = await keyOf();
      const api = agent37Api(key);
      const want = wanted(declared, { image, size });
      const id = await openInstance(api, key, { name, want, network: hosts, edge, budgetMs });
      const headers = { "X-Agent37-Key": key };
      const { stop, ...box } = runnerBox({ url: edge(id, RUNNER_PORT), headers, id });
      return {
        ...box,
        expose: async (port) => ({ url: edge(id, port), headers }),
        async stop() {
          // What runs in it is killed first, which a sleep would keep; a runner that cannot be
          // reached, or does not answer in time, kills nothing, and the sleep goes ahead.
          await Promise.race([stop().catch(() => undefined), delay(STOP_MS)]);
          await asleep(api, id, Date.now() + budgetMs);
        },
      };
    },
    async discard({ name }) {
      // An open in flight may yet make the instance: wait for it, so this removes it.
      await opening.get(name)?.catch(() => undefined);
      const api = agent37Api(await keyOf());
      await Promise.all((await holding(api, BOX, name)).map(({ id }) => api.remove(id)));
    },
  };
}

/** What `openInstance` opens: the box `name`, and what it is made as when there is none. */
interface Opening {
  name: string;
  want: Wanted;
  /** The group a new box is labelled with (`GROUP`), such as the company it is for. */
  group?: string;
  /**
   * The domains and addresses the box may reach: a new box is made with them, and one there with
   * any other network is set to them in place before it is woken. Not given, a new box reaches
   * anywhere and one there keeps its own.
   */
  network?: readonly string[];
  edge: (id: string, port: number) => string;
  budgetMs: number;
}

/**
 * The opens in flight in this process, by box name: a second open of a name waits for the first,
 * so one instance is made. Agent37 keeps metadata without reading it, so two opens of one name in
 * different processes at once can each make an instance.
 */
export const opening = new Map<string, Promise<string>>();

/**
 * Opens the box `name` with Agent37's API and edge, the key `key`: finds the instance whose
 * metadata holds its name or makes it (asleep when idle 15 minutes), its network set to `network`
 * either way when given, wakes or starts it, starts
 * the runner in it unless it answers, and puts pnpm in it with exec. It leaves no connection open,
 * which would keep the box awake. The instance's id.
 */
export function openInstance(api: Agent37Api, key: string, box: Opening): Promise<string> {
  const before = opening.get(box.name) ?? Promise.resolve();
  const opened = before.catch(() => undefined).then(() => openOnce(api, key, box));
  opening.set(box.name, opened);
  void opened.catch(() => undefined).then(() => opening.get(box.name) === opened && opening.delete(box.name));
  return opened;
}

async function openOnce(
  api: Agent37Api,
  key: string,
  { name, want, group, network, edge, budgetMs }: Opening,
): Promise<string> {
  const [found] = await holding(api, BOX, name);
  if (found && group !== undefined && found.metadata?.[GROUP] !== group) throw otherGroup(name, group);
  // A box that exists keeps its image; a new one's may be registered first, outside the budget.
  const template = found ? undefined : (want.image ?? (await boxTemplate(api, key)));
  const deadline = Date.now() + budgetMs;
  // Before it wakes, so a sleeping box wakes to its hosts (one made before reached anywhere); one
  // still awake from an earlier turn takes them within seconds, Agent37 says.
  if (found && network && !reaches(found, network)) await retrying(deadline, () => api.network(found.id, network));
  const made =
    found ??
    (await api.create(
      {
        template: template!,
        resources: { cpu: want.size, memory: want.memory, disk: want.disk },
        type: want.type,
        region: want.region,
        name: labelOf(name),
        metadata: { [BOX]: name, ...(group && { [GROUP]: group }) },
        ...(network && { network: { allow: [...network] } }),
        auto_sleep: true,
        idle_timeout_seconds: 900,
      },
      Math.max(1, deadline - Date.now()),
    ));
  await running(api, made, deadline);
  await runnerUp(api, made.id, edge(made.id, RUNNER_PORT), { "X-Agent37-Key": key }, deadline);
  // On every open, so a box whose runner an earlier release started gets it too.
  const pnpm = await api.exec(made.id, PNPM, Math.max(1, deadline - Date.now()));
  if (pnpm.exit_code !== 0) {
    throw new Error(
      `agent37: pnpm could not be put in the box ${made.id} (exit ${pnpm.exit_code}): ${pnpm.stderr.trim()}`,
    );
  }
  return made.id;
}

/**
 * The box image's template asked for or registered in flight, by workspace key and its name: opens
 * at once make one `GET` and at most one `POST` in each workspace. It goes once settled, so each later new box asks again, and a
 * template deleted in Agent37's dashboard is registered again.
 */
const registering = new Map<string, Promise<void>>();

/**
 * The template a new box with no declared image is made from: the box image of the `sanoma` this
 * connector is installed beside, the workspace's template `sanoma-box-<version>` (slugged, as
 * Agent37 takes a name), registered when the workspace has none. When it cannot be
 * had, a warning says why and the box is made from `BASE`: the image only spares the agents' installs.
 */
async function boxTemplate(api: Agent37Api, key: string): Promise<string> {
  const version = await installedSanoma(fileURLToPath(new URL("..", import.meta.url)));
  if (version === undefined) return instead("the installed sanoma's version, which tags its box image, is unknown");
  const image = `${BOX_IMAGE}:${version}`;
  const name = slugged(`sanoma-box-${version}`);
  const workspace = `${key}\n${name}`;
  let had = registering.get(workspace);
  if (!had) {
    had = api.template(name).then(
      () => undefined,
      (error: unknown) => {
        if (!isCode(error, "not_found")) throw error;
        return api.register({ name, image_ref: image }, TEMPLATE_MS);
      },
    );
    registering.set(workspace, had);
    void had.catch(() => undefined).then(() => registering.delete(workspace));
  }
  try {
    await had;
    return name;
  } catch (error) {
    return instead(`${image} could not be registered as the workspace's template ${name}: ${errorMessage(error)}`);
  }
}

/** `BASE`, with a warning that says `why` a new box is made from it. */
function instead(why: string): string {
  console.warn(`sanoma: agent37: a new box is made from ${BASE}: ${why}`);
  return BASE;
}

/**
 * Puts pnpm on the box's `PATH` unless it is there: the agents' installs run it, and Agent37's
 * templates have corepack but no pnpm. `~/.local/bin` comes first on their `PATH`, and a new box
 * has none.
 */
const PNPM = `set -e
command -v pnpm >/dev/null && exit 0
mkdir -p ~/.local/bin
corepack enable --install-directory ~/.local/bin pnpm
pnpm --version >/dev/null`;

/** How long `stop` waits for the runner to kill what runs in the box, in ms. */
const STOP_MS = 30_000;

/** Where the runner is kept in a box, under the home of the image's user, and its log. */
const RUNNER = ".sanoma/runner.cjs";
const LOG = ".sanoma/runner.log";
/** The most of the packed runner one exec carries: its body takes 128 KB. */
const CHUNK = 96_000;
/** The runner, gzipped in base64, as exec writes it in: packed once. */
let packing: Promise<string> | undefined;

/**
 * Starts the runner in the instance `id` unless it answers at `url` with this release's protocol:
 * writes it in with exec (gzip in base64, in chunks), ends the one that answered another protocol
 * (by the pid it answered), starts it detached, and waits until a runner of this protocol
 * answers, up to `deadline`. A box that slept kept it running; one that was stopped booted fresh
 * without it. One that answered nothing is never killed: when it was there all along, the new one
 * finds its port taken and ends, and the old one answers.
 */
async function runnerUp(
  api: Agent37Api,
  id: string,
  url: string,
  headers: Record<string, string>,
  deadline: number,
): Promise<void> {
  const found = await runnerHealth(url, headers);
  if (isCurrent(found)) return;
  const sh = async (command: string) => {
    const { exit_code, stderr } = await api.exec(id, `cd && ${command}`);
    if (exit_code !== 0) {
      throw new Error(`agent37: starting the runner in ${id} failed (exit ${exit_code}): ${stderr.trim()}`);
    }
  };
  const packed = await (packing ??= runnerScript().then(
    (script) => gzipSync(script).toString("base64"),
    (error: unknown) => {
      // A runner not built yet is not cached: the next open reads it again.
      packing = undefined;
      throw error;
    },
  ));
  // A file of its own, so two opens at once write theirs apart.
  const part = `.sanoma/runner-${randomBytes(4).toString("hex")}`;
  const writes: string[] = [];
  for (let at = 0; at < packed.length; at += CHUNK) {
    // Base64 is safe unquoted.
    writes.push(`mkdir -p .sanoma && printf %s ${packed.slice(at, at + CHUNK)} >${at ? ">" : ""} ${part}.b64`);
  }
  // The runner it replaces (another release's) ends first, and with it what it started: SIGTERM,
  // then SIGKILL after 5 s.
  const end = found
    ? `kill ${found.pid} 2>/dev/null; i=0; while kill -0 ${found.pid} 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; kill -9 ${found.pid} 2>/dev/null; `
    : "";
  // The last write starts it, detached, its output to a file: exec answers once nothing holds its own.
  writes[writes.length - 1] +=
    ` && base64 -d <${part}.b64 | gunzip >${part}.cjs && rm ${part}.b64 && mv ${part}.cjs ${RUNNER} && ` +
    `{ ${end}nohup node ${RUNNER} >${LOG} 2>&1 </dev/null & }`;
  for (const write of writes) await sh(write);
  // Node starts it in a fraction of a second.
  while (!isCurrent(await runnerHealth(url, headers))) {
    if (Date.now() > deadline) throw new Error(`agent37: the runner in ${id} does not answer; its log is ~/${LOG}`);
    await delay(200);
  }
}

/** Whether a runner's health is this release's protocol. */
const isCurrent = (health?: { protocol: number }) => health?.protocol === RUNNER_PROTOCOL;

/** Whether `instance` may connect to exactly `allow`, as Agent37 stores a list (a domain lowercase), and nowhere else. */
function reaches({ network }: Instance, allow: readonly string[]): boolean {
  if (typeof network !== "object") return false;
  const stored = new Set(network.allow);
  const asked = new Set(allow.map((host) => host.toLowerCase()));
  return stored.size === asked.size && [...asked].every((host) => stored.has(host));
}

/** The instances whose metadata holds `value` under `key` (`BOX` or `GROUP`), but those on their way out. */
export const holding = async (api: Agent37Api, key: string, value: string) =>
  (await api.list()).filter((i) => i.metadata?.[key] === value && !["deleting", "deleted"].includes(i.status));

/**
 * `call` again while Agent37 answers `try_again` (a sleep's checkpoint is being written), waiting
 * longer each time, until `deadline`; then fails with its last error.
 */
async function retrying<T>(deadline: number, call: () => Promise<T>): Promise<T> {
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 10_000)) {
    try {
      return await call();
    } catch (error) {
      if (!isCode(error, "try_again") || Date.now() + wait > deadline) throw error;
      await delay(wait);
    }
  }
}

/** Waits until the instance is running: starts it when it is stopped, wakes it when it sleeps. */
async function running(api: Agent37Api, instance: Instance, deadline: number): Promise<void> {
  for (;;) {
    let { status } = instance;
    if (["failed", "deleting", "deleted"].includes(status)) {
      const reason = instance.status_reason?.message ? `: ${instance.status_reason.message}` : "";
      throw new DriverError(
        `agent37: the instance ${instance.id} is ${status}${reason}; discard the box to make it again`,
        {
          retryable: false,
        },
      );
    }
    if (status === "stopped" || status === "sleeping")
      ({ status } = await retrying(deadline, () => api.start(instance.id)));
    if (status === "running") return;
    if (Date.now() > deadline) throw new Error(`agent37: the instance ${instance.id} is still ${status}`);
    await delay(2_000);
    instance = await api.get(instance.id);
  }
}

/** Puts the instance to sleep, its memory checkpointed; stops it when Agent37 refuses the sleep of a running instance (the checkpoint failed). */
export async function asleep(api: Agent37Api, id: string, deadline: number): Promise<void> {
  try {
    await retrying(deadline, () => api.sleep(id));
  } catch (error) {
    if (!isCode(error, "invalid_request") && !isCode(error, "provisioning_failed")) throw error;
    // Asleep already (it slept when idle) or stopped: nothing to do, and a stop would lose its memory.
    if (["sleeping", "stopped"].includes((await api.get(id)).status)) return;
    // Its disk is kept either way.
    await retrying(deadline, () => api.stop(id));
  }
}
