import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Box, SandboxBackend, SandboxContext } from "@sanoma-ai/workflows";
import { agent37Api, type Agent37Api, type Instance, isCode } from "./api.ts";
import { wanted } from "./connector.ts";
import { connect, RefusedError, sshBox, sshKey } from "./ssh.ts";

// The `Sandbox` backend on Agent37: a box is an instance, found by the name in its metadata,
// made when there is none, woken or started when it sleeps or is stopped; its commands and files
// go over SSH (`ssh.ts`), its ports through Agent37's edge, and `stop` puts it to sleep.

export const KEY = "AGENT37_API_KEY";

/** The metadata key a box's name is kept under: an instance's `name` is a label of 60 characters. */
export const BOX = "sanoma_box";

/** How long `open` and `stop` wait for an instance to be running, or asleep, in all. */
const BUDGET_MS = 3 * 60_000;

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
  { edge = (id, port) => `https://${id}-${port}.agent37.app`, budgetMs = BUDGET_MS }: Agent37BackendOptions = {},
): SandboxBackend {
  /** Each key's SSH key, registered with its workspace once. */
  const registered = new Map<string, { ssh: ReturnType<typeof sshKey>; registering: Promise<void> }>();
  const keyOf = async () => {
    const key = (await secrets([KEY])).get(KEY);
    if (!key) throw new Error(`agent37 is not configured: ${KEY} is not set; set it on the connector page`);
    return key;
  };
  /** The opens in flight, by name: a second open of a name waits for the first, so one instance is made. */
  const opening = new Map<string, Promise<Box>>();
  return {
    async open({ name, image, size }) {
      const before = opening.get(name) ?? Promise.resolve();
      const box = before.catch(() => undefined).then(() => openBox(name, image, size));
      opening.set(name, box);
      void box.catch(() => undefined).then(() => opening.get(name) === box && opening.delete(name));
      return box;
    },
    async discard({ name }) {
      const api = agent37Api(await keyOf());
      await Promise.all((await holding(api, name)).map(({ id }) => api.remove(id)));
    },
  };

  async function openBox(name: string, image: string, size: number): Promise<Box> {
    const want = wanted(declared, { image, size });
    const key = await keyOf();
    const api = agent37Api(key);
    const deadline = Date.now() + budgetMs;
    // The SSH key is registered while the instance is found or made; only the connect needs it.
    let known = registered.get(key);
    if (!known) {
      const ssh = sshKey(key);
      known = { ssh, registering: api.registerKey(ssh.publicKey, "sanoma") };
      registered.set(key, known);
      known.registering.catch(() => registered.delete(key));
    }
    const { ssh, registering } = known;
    const [found] = await holding(api, name);
    const made =
      found ??
      (await api.create(
        {
          template: want.image,
          resources: { cpu: want.size, memory: want.memory, disk: want.disk },
          type: want.type,
          region: want.region,
          name: labelOf(name),
          metadata: { [BOX]: name },
          auto_sleep: true,
          idle_timeout_seconds: 900,
        },
        Math.max(1, deadline - Date.now()),
      ));
    await running(api, made, deadline);
    await registering;
    const headers = { "X-Agent37-Key": key };
    const client = await untilDeadline(
      deadline,
      () => connect(edge(made.id, 22022), headers, ssh.privateKey, Math.max(1, deadline - Date.now())),
      (error) => !(error instanceof RefusedError),
    );
    const { end, ...commands } = sshBox(client);
    return {
      id: made.id,
      ...commands,
      expose: async (port) => ({ url: edge(made.id, port), headers }),
      async stop() {
        await end();
        await asleep(api, made.id, Date.now() + budgetMs);
      },
    };
  }
}

/** The instances that hold the box `name`, but those on their way out. */
const holding = async (api: Agent37Api, name: string) =>
  (await api.list()).filter((i) => i.metadata?.[BOX] === name && !["deleting", "deleted"].includes(i.status));

/**
 * Calls `attempt` until it succeeds, waiting longer each time, while `retry` says its error is
 * worth a wait and `deadline` has not passed; then fails with its last error.
 */
async function untilDeadline<T>(
  deadline: number,
  attempt: () => Promise<T>,
  retry: (error: unknown) => boolean,
): Promise<T> {
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 10_000)) {
    try {
      return await attempt();
    } catch (error) {
      if (!retry(error) || Date.now() + wait > deadline) throw error;
      await delay(wait);
    }
  }
}

/** `call` again while Agent37 answers `try_again` (a sleep's checkpoint is being written), until `deadline`. */
const retrying = <T>(deadline: number, call: () => Promise<T>) =>
  untilDeadline(deadline, call, (error) => isCode(error, "try_again"));

/** Waits until the instance is running: starts it when it is stopped, wakes it when it sleeps. */
async function running(api: Agent37Api, instance: Instance, deadline: number): Promise<void> {
  for (;;) {
    let { status } = instance;
    if (["failed", "deleting", "deleted"].includes(status)) {
      const reason = instance.status_reason?.message ? `: ${instance.status_reason.message}` : "";
      throw new Error(`agent37: the instance ${instance.id} is ${status}${reason}; discard the box to make it again`);
    }
    if (status === "stopped" || status === "sleeping")
      ({ status } = await retrying(deadline, () => api.start(instance.id)));
    if (status === "running") return;
    if (Date.now() > deadline) throw new Error(`agent37: the instance ${instance.id} is still ${status}`);
    await delay(2_000);
    instance = await api.get(instance.id);
  }
}

/** Puts the instance to sleep, its memory checkpointed; stops it when Agent37 refuses the sleep (not running, or the checkpoint failed). */
async function asleep(api: Agent37Api, id: string, deadline: number): Promise<void> {
  try {
    await retrying(deadline, () => api.sleep(id));
  } catch (error) {
    if (!isCode(error, "invalid_request") && !isCode(error, "provisioning_failed")) throw error;
    // Its disk is kept either way.
    await retrying(deadline, () => api.stop(id));
  }
}
