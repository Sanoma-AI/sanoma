import { DriverError, retryableStatus } from "sanoma/workflows";
import { z } from "zod";

// Agent37's Sandbox API (https://www.agent37.com/docs/agents-api/instances, and /templates), cut to
// the calls the connector makes, on `fetch`: there is no SDK. Every failure is a `DriverError` carrying
// Agent37's status and its error's `code` as `vendorCode`.

const API = "https://api.agent37.com/v1";

/** An instance as Agent37 shows one: the fields read here. */
export interface Instance {
  /** Ten lowercase letters and digits, the DNS label of its URLs. */
  id: string;
  /** `provisioning`, `running`, `stopping`, `stopped`, `starting`, `restarting`, `updating`, `sleeping`, `waking`, `failed`, `deleting` or `deleted`. */
  status: string;
  metadata?: Record<string, unknown> | null;
  status_reason?: { message?: string } | null;
}

/** What `POST /v1/instances` takes, cut to what the backend sends. */
interface InstanceCreate {
  template: string;
  resources: { cpu: number; memory: number; disk: number };
  type: string;
  region: string;
  name: string;
  metadata: Record<string, string>;
  auto_sleep: boolean;
  idle_timeout_seconds: number;
}

/** Agent37's error body: `{ error: { code, message } }`, or a flat `{ error: code }` from its edge. */
const Problem = z.object({
  error: z.union([z.object({ code: z.string(), message: z.string().optional() }), z.string()]),
});

/** The `DriverError` for Agent37's answer `status` with `body`: its `code` as `vendorCode`. */
function failure(where: string, status: number, body: unknown): DriverError {
  const error = Problem.safeParse(body).data?.error;
  const code = typeof error === "string" ? error : error?.code;
  const message = typeof error === "object" ? error.message : undefined;
  return new DriverError(`agent37: ${where} answered ${status}: ${message ?? code ?? "no reason given"}`, {
    // `try_again` is a state in transition (a checkpoint being written): a wait fixes it.
    retryable: retryableStatus(status) || code === "try_again",
    status,
    ...(code && { vendorCode: code }),
  });
}

/** Whether `error` is Agent37's answer `code`. */
export const isCode = (error: unknown, code: string) => error instanceof DriverError && error.vendorCode === code;

/** A rejection handler that takes Agent37's answer `code` as done, and fails on any other error. */
const unless = (code: string) => (error: unknown) => {
  if (!isCode(error, code)) throw error;
};

/** The Sandbox API with the key `key`; each request fails as a `DriverError` past `timeoutMs`. */
export function agent37Api(key: string, timeoutMs = 30_000) {
  async function send<T>(method: string, path: string, body?: object, ms = timeoutMs): Promise<T> {
    const where = `${method} ${path}`;
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body && { "content-type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      // No `cause`: a header's error echoes its value, the key.
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new DriverError(`agent37: ${where}: ${timedOut ? `no reply in ${ms} ms` : "no reply"}`, {
        retryable: true,
      });
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw failure(where, res.status, parsed);
    return parsed as T;
  }
  return {
    list: async () => (await send<{ data: Instance[] }>("GET", "/instances")).data,
    get: (id: string) => send<Instance>("GET", `/instances/${id}`),
    /** Answers once the instance is `running`, which takes as long as its image takes to start: `ms`. */
    create: (body: InstanceCreate, ms: number) => send<Instance>("POST", "/instances", body, ms),
    /** Starts a stopped instance, or wakes a sleeping one. */
    start: (id: string) => send<Instance>("POST", `/instances/${id}/start`),
    /** Checkpoints its memory and processes; it wakes at the next `start`. */
    sleep: (id: string) => send<Instance>("POST", `/instances/${id}/sleep`),
    stop: (id: string) => send<Instance>("POST", `/instances/${id}/stop`),
    remove: (id: string) => send("DELETE", `/instances/${id}`).then(() => undefined, unless("not_found")),
    /**
     * Runs `command` with `sh -c` as the image's user, buffered: no stdin, its output back once it
     * has exited (each stream up to 512 KB), its body up to 128 KB.
     */
    exec: (id: string, command: string) =>
      send<{ exit_code: number; stdout: string; stderr: string }>("POST", `/instances/${id}/exec`, { command }),
    /** The workspace's template `name`: `not_found` when it has none. */
    template: (name: string) => send<{ name: string }>("GET", `/templates/${name}`),
    /**
     * Registers the image `image_ref` as the workspace's template `name`. Agent37 copies the image
     * before it answers, which takes up to `ms`; a template of that name there already is done.
     */
    register: (body: { name: string; image_ref: string }, ms: number) =>
      send("POST", "/templates", body, ms).then(() => undefined, unless("template_conflict")),
  };
}

export type Agent37Api = ReturnType<typeof agent37Api>;
