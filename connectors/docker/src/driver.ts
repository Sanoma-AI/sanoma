import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBridge, type ProviderClient } from "@sanoma-ai/bridge";
import { DriverError } from "@sanoma-ai/workflows";
import { z } from "zod";
import { CREATE_ONLY, dockerTf, LABELS } from "./connector.ts";

export interface DockerDriverOptions {
  /**
   * The provider bridge to run the provider on. Default: the process's `defaultBridge()`, started
   * on the first call from `SANOMA_BRIDGE_BIN`.
   */
  bridge?: ProviderClient;
  /** The Docker daemon's address, `unix:///…` or `tcp://…`. Default: `dockerHost()`, on every call. */
  host?: string;
  /** Reads a container as Docker's API answers `GET /containers/{id}/json`. Default: that request to the daemon. */
  inspect?: Inspect;
}

/** The environment variables the driver reads, on every call. */
const env = z.object({
  DOCKER_HOST: z
    .string()
    .optional()
    .describe("the Docker daemon's address; default: the active docker context's, else Docker Desktop's socket"),
});

/** What the driver reads of Docker's inspect of a container. */
export interface Inspected {
  Id: string;
  Config: { Env?: string[] | null; Labels?: Record<string, string> | null };
  HostConfig: { PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null };
  State: { Running: boolean };
}

/** Docker's inspect of a container by its id or name; undefined when there is none. */
export type Inspect = (host: string, id: string) => Promise<Inspected | undefined>;

const readJson = (file: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return undefined;
  }
};

/**
 * The Docker daemon's address, as the `docker` command finds it: `DOCKER_HOST`, else the
 * endpoint of the active context (`DOCKER_CONTEXT`, else the config's `currentContext`), else
 * Docker Desktop's socket (`~/.docker/run/docker.sock`) when there is one, else
 * `/var/run/docker.sock`.
 */
export function dockerHost(environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (environment.DOCKER_HOST) return environment.DOCKER_HOST;
  const dir = environment.DOCKER_CONFIG ?? join(home, ".docker");
  const context = environment.DOCKER_CONTEXT ?? readJson(join(dir, "config.json"))?.currentContext;
  if (typeof context === "string" && context && context !== "default") {
    const id = createHash("sha256").update(context).digest("hex");
    const host = readJson(join(dir, "contexts", "meta", id, "meta.json"))?.Endpoints?.docker?.Host;
    if (typeof host === "string" && host) return host;
  }
  const desktop = join(dir, "run", "docker.sock");
  return `unix://${existsSync(desktop) ? desktop : "/var/run/docker.sock"}`;
}

/** `GET /containers/{id}/json` on the daemon at `host` (a unix socket or `tcp://`, over HTTP). */
export const inspectContainer: Inspect = (host, id) =>
  new Promise((resolve, reject) => {
    const path = `/containers/${encodeURIComponent(id)}/json`;
    const at = host.startsWith("unix://")
      ? { socketPath: host.slice("unix://".length) }
      : host.startsWith("tcp://")
        ? {
            host: new URL(host.replace(/^tcp:/, "http:")).hostname,
            port: Number(new URL(host.replace(/^tcp:/, "http:")).port),
          }
        : undefined;
    if (!at)
      return reject(
        new DriverError(`docker: cannot reach ${host}: only unix:// and tcp:// hosts`, { retryable: false }),
      );
    const req = request({ ...at, path, timeout: 30_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 404) return resolve(undefined);
        if (res.statusCode !== 200) {
          return reject(
            new DriverError(`docker: GET ${path} answered ${res.statusCode}: ${body.slice(0, 200)}`, {
              retryable: true,
            }),
          );
        }
        resolve(JSON.parse(body) as Inspected);
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (e) =>
      reject(new DriverError(`docker: GET ${path} failed: ${e.message}`, { retryable: true, cause: e })),
    );
    req.end();
  });

/**
 * An imported container's state with what the provider's read leaves out: its environment
 * variables (those its `sanoma.env` label names), its `sanoma.*` labels and its published ports
 * from Docker's inspect, and the attributes only a config sets (`CREATE_ONLY`; `must_run` while
 * it runs). The provider reads neither environment nor labels back, so without this an imported
 * container plans a replace.
 */
export function observed(state: Record<string, unknown>, container: Inspected): Record<string, unknown> {
  const labels = container.Config.Labels ?? {};
  const names = new Set((labels[LABELS.env] ?? "").split(",").filter(Boolean));
  return {
    ...state,
    ...CREATE_ONLY,
    must_run: container.State.Running,
    env: (container.Config.Env ?? []).filter((entry) => names.has(entry.slice(0, entry.indexOf("=")))),
    labels: Object.entries(labels)
      .filter(([label]) => label.startsWith("sanoma."))
      .map(([label, value]) => ({ label, value })),
    ports: Object.entries(container.HostConfig.PortBindings ?? {}).flatMap(([port, bindings]) => {
      const [internal = "", protocol = "tcp"] = port.split("/");
      return (bindings ?? []).map((b) => ({
        internal: Number(internal),
        external: Number(b.HostPort),
        ip: b.HostIp || "0.0.0.0",
        protocol,
      }));
    }),
  };
}

/**
 * `bridge`, its imports of a container `observed` through Docker's inspect, inside the driver
 * only, and by its name too (the provider finds one by its id alone).
 */
function observing(bridge: ProviderClient, host: () => string, inspect: Inspect): ProviderClient {
  return {
    configure: (...args) => bridge.configure(...args),
    read: (...args) => bridge.read(...args),
    plan: (...args) => bridge.plan(...args),
    apply: (...args) => bridge.apply(...args),
    close: (...args) => bridge.close(...args),
    import: async (ref, typeName, id) => {
      const container = await inspect(host(), id);
      const reply = await bridge.import(ref, typeName, container?.Id ?? id);
      if (!container) return reply;
      const resources = reply.resources.map((r) =>
        r.typeName === "docker_container"
          ? { ...r, stateJson: JSON.stringify(observed(JSON.parse(r.stateJson) as Record<string, unknown>, container)) }
          : r,
      );
      return { ...reply, resources };
    },
  };
}

/**
 * Containers on the Docker daemon at `host` (`dockerHost()` by default, on every call) through
 * the `kreuzwerker/docker` OpenTofu provider on `bridge` (the default bridge when none is given).
 * An import also inspects the container, for the environment and labels the provider never reads
 * back; the environment holds secrets, so it stays inside the driver (the type's `writeOnly`).
 */
export function dockerDriver({ bridge = defaultBridge(), host, inspect = inspectContainer }: DockerDriverOptions = {}) {
  const at = () => host ?? dockerHost();
  return Object.freeze({ ...dockerTf.driver(observing(bridge, at, inspect), () => ({ host: at() })), env });
}
