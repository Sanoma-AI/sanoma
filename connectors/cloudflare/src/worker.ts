import { readFile } from "node:fs/promises";
import type { SitesBundle } from "@sanoma-ai/workflows/shared";

// The company's Worker, as the package ships it in `worker/`: the files `cloudflare.container`
// uploads, and the object's code, which the fake runs in this process.

const WORKER = new URL("../worker/", import.meta.url);

/** The Worker's entry module, which imports `cloudflare:workers` and `instance.js`. */
export const MAIN_MODULE = "index.js";
/** The modules uploaded, the entry first. */
const MODULES = [MAIN_MODULE, "instance.js"] as const;
/** The entry module of a Worker that serves the public sites, beside `MODULES` and the sites bundle under `sites/` (`sites.ts`). */
export const SITES_MODULE = "sites.js";

/** The Durable Object class the Worker exports, which the container application runs behind. */
export const OBJECT_CLASS = "SanomaInstance";

/** One module of the Worker: its file name, which the upload names it by, and its source. */
export interface WorkerModule {
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
  /** What the module is, as the upload types its part: an ES module unless it says. */
  type?: SitesBundle["modules"][number]["type"];
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

let router: Promise<WorkerModule> | undefined;

/** The sites router, `worker/sites.js`, read from the package once. */
export function sitesRouter(): Promise<WorkerModule> {
  router ??= readFile(new URL(SITES_MODULE, WORKER), "utf8").then((content) => ({ name: SITES_MODULE, content }));
  return router;
}

export {
  HEALTH_PATH,
  IMAGE,
  INACTIVITY_MS,
  Instance,
  NAMESPACE,
  type ObjectState,
  worker,
} from "../worker/instance.js";
