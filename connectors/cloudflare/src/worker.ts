import { readFile } from "node:fs/promises";

// The company's Worker, as the package ships it in `worker/`: the files `cloudflare.container`
// uploads, and the object's code, which the fake runs in this process.

const WORKER = new URL("../worker/", import.meta.url);

/** The Worker's entry module, which imports `cloudflare:workers` and `instance.js`. */
export const MAIN_MODULE = "index.js";
/** The modules uploaded, the entry first. */
const MODULES = [MAIN_MODULE, "instance.js"] as const;

/** The Durable Object class the Worker exports, which the container application runs behind. */
export const OBJECT_CLASS = "SanomaInstance";
/** The Worker's binding to its own object (`NAMESPACE` in `worker/instance.js`). */
export const NAMESPACE = "SANOMA_INSTANCE";
/** The object's route for the wake it holds (`WAKE_PATH` in `worker/instance.js`). */
export const WAKE_PATH = "/__sanoma/wake";
/** The object's route that answers `{ revision }` once the container does (`HEALTH_PATH` in `worker/instance.js`). */
export const HEALTH_PATH = "/__sanoma/health";
/** How long the container runs after its last request before Cloudflare stops it (`INACTIVITY_MS` in `worker/instance.js`). */
export const INACTIVITY_MS = 10 * 60 * 1000;

/** One module of the Worker: its file name, which the upload names it by, and its source. */
export interface WorkerModule {
  name: string;
  content: string;
}

let modules: Promise<WorkerModule[]> | undefined;

/** The Worker's modules, read from the package once. */
export function workerModules(): Promise<WorkerModule[]> {
  modules ??= Promise.all(
    MODULES.map(async (name) => ({ name, content: await readFile(new URL(name, WORKER), "utf8") })),
  ).catch((err: unknown) => {
    modules = undefined;
    throw err;
  });
  return modules;
}

/** What the object's code needs of a Durable Object's `ctx`: its container and its storage. */
export interface ObjectState {
  container: {
    readonly running: boolean;
    start(options: { env: Record<string, string>; enableInternet: boolean; labels: Record<string, string> }): void;
    inspect(): Promise<{ image: string; labels: Record<string, string> } | null>;
    destroy(reason?: string): Promise<void>;
    getTcpPort(port: number): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
    setInactivityTimeout(ms: number): Promise<void>;
  };
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** One object of the Worker, as `worker/instance.js` makes it. */
export interface Instance {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}

/** `worker/instance.js`, loaded in this process. */
export interface InstanceModule {
  Instance: new (ctx: ObjectState, env: Record<string, unknown>) => Instance;
  worker: { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
}

/** The object's code, `worker/instance.js`, which has no imports, so Node loads it as it is. */
export const loadInstance = (): Promise<InstanceModule> =>
  import(new URL("instance.js", WORKER).href) as Promise<InstanceModule>;
