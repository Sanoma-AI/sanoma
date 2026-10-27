import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as forwardRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  type DriftResult,
  errorMessage,
  type HostLifetime,
  isEnded,
  type PlanAction,
  type Resource,
  resolveSecrets,
  type SanomaClient,
  type SanomaConfig,
  superviseWorker,
  type SupervisorOptions,
  withSetup,
} from "@sanoma-ai/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import { testWorkerConfig } from "./index.ts";

// The conformance kit for the `Host` contract: whether a host runs the company as the runtime
// needs. `checkHost` drives a declared host through callbacks (apply it, stop it, commit to its
// source, check it for drift) and a client on its database, and reports each check. The host's
// config carries `hostCheck` and `hostCheckWorkflows`, which the checks start runs of.
// `fakeHost` is a host in this process, for the kit's own tests and for building against the
// contract before a real host lands: long-lived, or behind a proxy that starts it again on the
// next request after it stops, as a host that scales to zero does.

type State = Record<string, unknown>;

/** The variable the credential check sets: the host's worker must hear the change over `LISTEN`. */
export const HOST_CHECK_CREDENTIAL = "HOST_CHECK_TOKEN";

/** A digest of a credential's value, which the probe reports instead of the value. */
const credentialDigest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const hostCheckOps = defineConnector("hostcheck", {
  probe: {
    digest: {
      effect: "read",
      idempotent: true,
      description: `A digest of ${HOST_CHECK_CREDENTIAL} as the worker holds it, never the value`,
      input: z.object({}),
      output: z.object({ digest: z.string() }),
    },
  },
});
const hostCheckDriver = defineDriver(
  hostCheckOps,
  { probe: { digest: async () => ({ digest: credentialDigest(process.env[HOST_CHECK_CREDENTIAL] ?? "") }) } },
  { env: z.object({ [HOST_CHECK_CREDENTIAL]: z.string().describe("Any value: the host check sets it") }) },
);

/**
 * The connector the credential check calls, for the host's config: `hostcheck.probe.digest`, a
 * digest of the credential as the worker holds it.
 */
export const hostCheck = withSetup(hostCheckOps, { driver: () => hostCheckDriver });

/** The workflows the checks start, which the host's config registers: a run that drains, a sleep, the credential probe. */
export const hostCheckWorkflows = [
  defineWorkflow({
    name: "host-check-drain",
    trigger: "manual",
    input: z.object({}),
    uses: [],
    run: async () => ({ drained: true }),
  }),
  defineWorkflow({
    name: "host-check-sleep",
    trigger: "manual",
    input: z.object({ seconds: z.number() }),
    uses: ["sleep"],
    run: async (ctx, { seconds }) => {
      await ctx.sleep({ seconds });
      return { slept: seconds };
    },
  }),
  defineWorkflow({
    name: "host-check-credential",
    trigger: "manual",
    input: z.object({}),
    uses: [hostCheck.probe.digest],
    run: async (ctx) => ctx.hostcheck.probe.digest({}),
  }),
] as const;

/** A declared host under test, and how to drive it. */
export interface HostUnderTest {
  /** Its resource type, which meets the contract (`host`). */
  type: Pick<Resource, "vendor" | "type" | "host">;
  /** Makes the host match its declaration, its revision what its ref names now; returns its state. */
  apply(): Promise<State>;
  /** Stops the host through its resource's operations (its `delete`); `apply` starts it again. */
  stop(): Promise<void>;
  /**
   * Stops the company's runtime the way the host's lifetime does (it goes quiet), its URL kept:
   * the next request to the URL starts it again. Required unless the host is `long-lived`.
   */
  suspend?(): Promise<void>;
  /** A client on the host's database, its config with `hostCheck` and `hostCheckWorkflows`. */
  client: SanomaClient;
  /** The values the host was given as secrets: none may appear in a ledger record. */
  secrets: readonly string[];
  /** Makes a new commit on the host's source at its ref; returns its revision. */
  commit(): Promise<string>;
  /** A drift check's row for the host's declaration. */
  drift(): Promise<DriftResult>;
  /** How long a check waits for the host. Default 60 s. */
  timeoutMs?: number;
}

/** One check's outcome. */
export interface HostCheck {
  name: string;
  ok: boolean;
  error?: string;
}

const startedBy = { id: "host-check" };

/** `runId`'s run once it has ended, or undefined after `timeoutMs`. */
export const runEnded = (client: SanomaClient, runId: string, timeoutMs: number) =>
  waitFor(
    () => client.run(runId),
    (r) => r !== undefined && isEnded(r.status),
    timeoutMs,
  );

/**
 * Sets the check's credential to `credential` and waits until a probe run reads it: the worker,
 * which loads the value when it hears the change over `LISTEN`, holds it (until then a probe
 * fails, or reads the old one). The host and database kits' check.
 */
export async function credentialHeard(
  client: SanomaClient,
  credential: string,
  by: { id: string },
  timeoutMs: number,
): Promise<void> {
  await client.setCredential(HOST_CHECK_CREDENTIAL, credential, { by: by.id });
  await waitFor(
    async () => {
      const runId = await client.start("host-check-credential", {}, { startedBy: by });
      const run = await runEnded(client, runId, timeoutMs);
      return run?.status === "finished" ? ((await client.result(runId)) as { digest: string }).digest : undefined;
    },
    (seen) => seen === credentialDigest(credential),
    timeoutMs,
  );
}

/**
 * Runs the conformance checks against a host, in order, each on its own (one failing goes on to
 * the next): the app answers on its port, a queued run drains, `LISTEN` hears a credential
 * change, a sleep survives a restart, a new commit shows as drift that apply clears, and no
 * secret is in the ledger. A host that stops (`stops-when-quiet`) is also checked
 * for what a request to its URL starts again (`suspend`, then a `/wake`): a run queued while it
 * was stopped drains, and a sleep that ended while it was stopped continues. Leaves the host
 * applied, and its check's credential cleared.
 */
export async function checkHost(host: HostUnderTest): Promise<HostCheck[]> {
  const { type, client, timeoutMs = 60_000 } = host;
  const spec = type.host;
  if (!spec) throw new Error(`${type.vendor}.${type.type} does not meet the Host contract: it has no host`);
  const credential = randomBytes(18).toString("base64url");
  const results: HostCheck[] = [];
  // The state the last apply returned: its URL is where the host answers now.
  let applied: State = {};
  const apply = async () => (applied = await host.apply());
  const check = async (name: string, run: () => Promise<void>) => {
    // A host that never answered fails the rest at once, rather than each after its timeout.
    if (results[0]?.ok === false) return void results.push({ name, ok: false, error: "the host did not answer" });
    try {
      await run();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: errorMessage(err) });
    }
  };
  const finish = async (runId: string) => {
    const run = await runEnded(client, runId, timeoutMs);
    if (run?.status !== "finished") throw new Error(`run ${runId} ended ${run?.status}: ${run?.error}`);
  };

  // A value an earlier check left, under another key, would stop the host's worker from starting.
  await client.clearCredential(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
  await check("the app answers on its port", async () => {
    const outputs = spec.outputs(await apply());
    if (!outputs.healthy) throw new Error("its state says it is not healthy");
    const res = await fetch(new URL("/healthz", outputs.url));
    if (!res.ok) throw new Error(`${outputs.url}/healthz answered ${res.status}`);
  });
  await check("a queued run drains", async () => {
    await finish(await client.start("host-check-drain", {}, { startedBy }));
  });
  await check("LISTEN hears a credential change", () => credentialHeard(client, credential, startedBy, timeoutMs));
  await check("a sleep survives a restart", async () => {
    const runId = await client.start("host-check-sleep", { seconds: 2 }, { startedBy });
    await waitFor(async () => (await client.ledger(runId)).some((r) => r.type === "sleep.started"), Boolean, timeoutMs);
    await host.stop();
    await apply();
    await finish(runId);
  });
  if (spec.capabilities.lifetime !== "long-lived") {
    const suspend = async () => {
      if (!host.suspend) throw new Error(`a host that is ${spec.capabilities.lifetime} needs suspend to be checked`);
      await host.suspend();
    };
    // A request, as a wakeup sends it, until the host answers 204 (one starting may answer 503 first).
    const wake = async () => {
      const at = new URL("/wake", spec.outputs(applied).url);
      const answer = () => fetch(at).then((res) => res.status, errorMessage);
      await waitFor(answer, (status) => status === 204, timeoutMs);
    };
    await check("a queued run drains after a stop and a wake", async () => {
      await suspend();
      const runId = await client.start("host-check-drain", {}, { startedBy });
      await wake();
      await finish(runId);
    });
    await check("a sleep that ends while stopped continues after a wake", async () => {
      const runId = await client.start("host-check-sleep", { seconds: 3 }, { startedBy });
      const sleep = await waitFor(
        async () => (await client.ledger(runId)).find((r) => r.type === "sleep.started"),
        Boolean,
        timeoutMs,
      );
      await suspend();
      const until = sleep?.type === "sleep.started" ? sleep.until : Date.now();
      await delay(Math.max(0, until - Date.now()) + 500);
      await wake();
      await finish(runId);
    });
  }
  await check("a new commit shows as drift that apply clears", async () => {
    const revision = await host.commit();
    const drifted = await host.drift();
    const field = drifted.fields.find((f) => f.path === spec.revision);
    if (drifted.status !== "drifted" || field?.desired !== revision) {
      throw new Error(`after a commit, drift says ${drifted.status} ${JSON.stringify(drifted.fields)}`);
    }
    await apply();
    const cleared = await host.drift();
    if (cleared.status !== "clean")
      throw new Error(`after apply, drift says ${cleared.status} ${JSON.stringify(cleared.fields)}`);
  });
  await check("no secret is in the ledger", async () => {
    const secrets = [...host.secrets, credential].filter((s) => s.length >= 8);
    const leaks: string[] = [];
    const runs = await client.runs({ limit: 1000 });
    const ledgers = await Promise.all(runs.map((run) => client.ledger(run.runId)));
    runs.forEach((run, i) => {
      const text = JSON.stringify(ledgers[i]);
      if (secrets.some((secret) => text.includes(secret))) leaks.push(run.runId);
    });
    if (leaks.length) throw new Error(`a secret is in the ledger of ${leaks.join(", ")}`);
  });
  await client.clearCredential(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
  return results;
}

/** True when a Docker daemon answers the `docker` command: a test of a container host skips without one. */
export const dockerAvailable = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

/**
 * A host's `apply` and `drift` through the built-in workflows on `client`, whose config declares
 * the host at `id` (`<file>#<export>`): `apply` runs the apply workflow for it alone, fails unless
 * the plan has no problem and every step is done, and returns `read` of the binding it left (its
 * type's `import`, called directly); `drift` runs the drift workflow and returns the host's row;
 * `binding` is the host's binding after the last apply.
 */
export function throughWorkflows(
  client: SanomaClient,
  id: string,
  read: (binding: string) => Promise<State>,
  timeoutMs = 600_000,
): Pick<HostUnderTest, "apply" | "drift"> & { binding(): string | undefined } {
  let bound: string | undefined;
  const run = async (runId: string) => {
    const ended = await waitFor(
      () => client.run(runId),
      (r) => r !== undefined && isEnded(r.status),
      timeoutMs,
    );
    if (ended?.status !== "finished") throw new Error(`run ${runId} ended ${ended?.status}: ${ended?.error}`);
  };
  return {
    async apply() {
      const runId = await client.apply({ only: [id] }, { startedBy });
      await run(runId);
      const { plan, results, lockfile } = await client.applyReport(runId);
      const failed = [
        ...plan.problems.map((p) => p.message),
        ...results.filter((r) => r.status !== "done").map((r) => `${r.action} ${r.status}: ${r.error ?? ""}`),
      ];
      if (failed.length) throw new Error(`apply of ${id}: ${failed.join("; ")}`);
      bound = lockfile.bindings[id]?.id;
      if (bound === undefined) throw new Error(`apply left ${id} unbound`);
      return read(bound);
    },
    async drift() {
      const runId = await client.drift({ startedBy });
      await run(runId);
      const row = (await client.driftReport(runId)).resources.find((r) => r.id === id);
      if (!row) throw new Error(`drift has no row for ${id}`);
      return row;
    },
    binding: () => bound,
  };
}

/** A `GET /wake` the runtime answered: when. */
export interface Wake {
  at: Date;
}

/** What `fakeHost` starts for a revision: the runtime, answering at `url`, until `stop`. */
export interface Running {
  url: string;
  stop(): Promise<void>;
  /** Each `GET /wake` it answered, in order, when it records them (`inProcessHost` does). */
  wakes?: readonly Wake[];
}

/** Starts the runtime at a revision on a port (0: any free one), given its secrets. */
export type StartHost = (input: {
  port: number;
  revision: string;
  secrets: Record<string, string>;
}) => Promise<Running>;

const fakeSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  ref: z.string().min(1),
  secrets: z.record(z.string(), z.string()).optional(),
  port: z.number().int().nonnegative(),
  revision: z.string().optional(),
  url: z.string().optional(),
  running: z.boolean().optional(),
});

/** `testhost.app` with the lifetime its `fakeHost` has. */
const hostType = (lifetime: HostLifetime) =>
  defineResource({
    vendor: "testhost",
    type: "app",
    title: "Test host",
    identity: "name",
    schema: fakeSchema,
    fields: {
      immutable: [],
      vendorOwned: ["url", "running"],
      writeOnly: ["secrets"],
      // A data file may name its source by the repository it declares, whose clone URL apply gives it.
      references: { source: { type: "github.repository", by: ["http_clone_url"] } },
    },
    find: ({ name }) => name,
    bindingId: (state) => String(state.name),
    writable: true,
    host: {
      capabilities: { lifetime, publicUrl: false, buildsFromGit: true, staticEgress: false },
      inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port" },
      revision: "revision",
      outputs: (state) => ({
        url: String(state.url ?? ""),
        ...(typeof state.revision === "string" && { revision: state.revision }),
        healthy: state.running === true,
      }),
    },
  });

/** The fake host's type, `testhost.app`, long-lived: a host in this process, which `fakeHost` drives. */
export const fakeHostType = hostType("long-lived");

/** How `fakeHost` runs: long-lived (the default), or one that stops and starts again on a request. */
export interface FakeHostOptions {
  lifetime?: HostLifetime;
  /** For `stops-when-quiet`: stops the runtime once no request has been open for this long. Default: never by itself. */
  quietAfterMs?: number;
}

/** A host that stops: the proxy at its URL, and the runtime behind it it starts on a request. */
interface Proxy extends Running {
  wakes: readonly Wake[];
  /** Stops the runtime, the proxy kept. */
  suspend(): Promise<void>;
  /** Stops the runtime, and starts the one `begin` starts in its place. */
  replace(begin: () => Promise<Running>): Promise<void>;
}

/** The proxy's answer when it could not reach the runtime. */
const unreachable = (res: ServerResponse, err: unknown) => {
  if (res.headersSent) return void res.destroy();
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`${errorMessage(err)}\n`);
};

/** Listens on `port` (0: any free one) on this machine; returns its URL. */
async function listen(server: Server, port: number): Promise<string> {
  await new Promise<void>((done, fail) => server.once("error", fail).listen(port, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A proxy on `port` (0: any free one) in front of the runtime `begin` starts, started now: each
 * request starts it again when it is stopped (one start at a time) and is forwarded to it, and
 * `quietAfterMs` after the last open request closes it stops by itself.
 */
async function proxy(begin: () => Promise<Running>, port: number, quietAfterMs?: number): Promise<Proxy> {
  let runtime: Promise<Running> | undefined;
  let stopping: Promise<void> = Promise.resolve();
  // Every runtime it started, for the wakes each answered.
  const runs: Running[] = [];
  let open = 0;
  let quiet: NodeJS.Timeout | undefined;
  const up = () =>
    (runtime ??= stopping
      .then(() => begin())
      .then(
        (started) => {
          runs.push(started);
          return started;
        },
        (err: unknown) => {
          runtime = undefined;
          throw err;
        },
      ));
  const suspend = async () => {
    clearTimeout(quiet);
    const was = runtime;
    runtime = undefined;
    if (was) {
      stopping = was.then(
        (started) => started.stop(),
        () => undefined,
      );
    }
    await stopping;
  };
  const rest = () => {
    if (quietAfterMs === undefined || open > 0) return;
    clearTimeout(quiet);
    quiet = setTimeout(() => void suspend(), quietAfterMs).unref();
  };
  const server = createServer((req, res) => {
    open++;
    clearTimeout(quiet);
    res.once("close", () => {
      open--;
      rest();
    });
    up().then(
      (started) => {
        const forward = forwardRequest(
          new URL(req.url ?? "/", started.url),
          { method: req.method, headers: req.headers },
          (answer) => {
            res.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(res);
          },
        );
        forward.once("error", (err) => unreachable(res, err));
        req.pipe(forward);
      },
      (err: unknown) => unreachable(res, err),
    );
  });
  const url = await listen(server, port);
  try {
    await up();
  } catch (err) {
    server.close();
    throw err;
  }
  rest();
  return {
    url,
    get wakes() {
      return runs.flatMap((started) => started.wakes ?? []);
    },
    suspend,
    async replace(next) {
      await suspend();
      begin = next;
      await up();
      rest();
    },
    async stop() {
      begin = () => Promise.reject(new Error("the host is deleted"));
      await suspend();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/**
 * A host in this process: `testhost.app` with a driver that runs `start` for each create and
 * update (every change is a replace, as for a container) and stops it on delete. Its state holds
 * no secret. `connector` is for a config; `driver` for calling its operations directly; `type`
 * is its resource type, whose `capabilities.lifetime` is `options.lifetime`.
 *
 * Long-lived (the default), its URL is the runtime's own. Otherwise its URL is a proxy on the
 * declared port in front of the runtime: `stop` (and, for `stops-when-quiet`, `quietAfterMs`)
 * stops the runtime while the proxy stays, and the next request starts it again, at the same
 * revision with the same secrets, and is forwarded to it. A replace keeps the proxy.
 */
export function fakeHost(start: StartHost, { lifetime = "long-lived", quietAfterMs }: FakeHostOptions = {}) {
  if (quietAfterMs !== undefined && lifetime !== "stops-when-quiet") {
    throw new Error(`fakeHost: quietAfterMs is for a host that stops-when-quiet, not one that is ${lifetime}`);
  }
  const type = lifetime === "long-lived" ? fakeHostType : hostType(lifetime);
  const ops = defineConnector(
    "testhost",
    { app: type },
    {
      title: "Test host",
      // Only what a data file imports it from: no such package is published.
      package: "@sanoma-ai/testing-host",
    },
  );
  const hosts = new Map<string, { state: Omit<z.output<typeof fakeSchema>, "secrets">; running: Running | Proxy }>();
  const stateOf = (id: string) => hosts.get(id)?.state;
  const read = async ({ id }: { id: string }) => {
    const state = stateOf(id);
    return state ? { id, gone: false, state } : { id, gone: true };
  };
  const remove = async (id: string) => {
    const host = hosts.get(id);
    hosts.delete(id);
    await host?.running.stop();
  };
  const run = async (desired: Record<string, unknown>, secrets: Parameters<typeof resolveSecrets>[1]) => {
    const declared = fakeSchema.parse(await resolveSecrets(desired, secrets));
    const revision = declared.revision ?? "";
    const begin = () =>
      start({ port: lifetime === "long-lived" ? declared.port : 0, revision, secrets: declared.secrets ?? {} });
    const { secrets: _, ...kept } = declared;
    const was = hosts.get(declared.name);
    // A host that stops keeps its proxy, and so its URL, across a replace on the same port.
    const reused = was && "replace" in was.running && was.state.port === declared.port ? was.running : undefined;
    let running: Running | Proxy;
    if (reused) {
      running = reused;
      // A runtime that does not start leaves no host, as a container's failed replace does.
      await reused.replace(begin).catch(async (err: unknown) => {
        await remove(declared.name);
        throw err;
      });
    } else {
      await remove(declared.name);
      running = lifetime === "long-lived" ? await begin() : await proxy(begin, declared.port, quietAfterMs);
    }
    const state = { ...kept, revision, url: running.url, running: true };
    hosts.set(declared.name, { state, running });
    return { id: declared.name, state };
  };
  const driver = defineDriver(ops, {
    app: {
      import: read,
      read,
      // Every change replaces it, as a container's does.
      plan: async ({
        id,
        desired,
      }): Promise<{ action: PlanAction; planned?: State; unknown: string[]; replace: string[] }> => {
        const state: State | undefined = id === undefined ? undefined : stateOf(id);
        if (!desired) return { action: state ? "delete" : "none", unknown: [], replace: [] };
        const { secrets: _, ...planned } = desired;
        if (!state) return { action: "create", planned, unknown: ["url", "running"], replace: [] };
        const replace = ["source", "ref", "port", "revision"].filter((f) => f in desired && desired[f] !== state[f]);
        return { action: replace.length ? "replace" : "none", planned: { ...state, ...planned }, unknown: [], replace };
      },
      create: async ({ desired }, call) => run(desired, call.secrets),
      update: async ({ desired }, call) => run(desired, call.secrets),
      delete: async ({ id }) => {
        await remove(id);
        return { id, gone: true as const };
      },
    },
  });
  const named = (name?: string) => [...hosts].filter(([id]) => name === undefined || id === name).map(([, h]) => h);
  return {
    type,
    connector: withSetup(ops, { driver: () => driver }),
    driver,
    /**
     * Stops the runtime behind the URL of the host `name` (default: every one), as its lifetime
     * would, the URL kept: the next request starts it again. Refused for a long-lived host.
     */
    async stop(name?: string) {
      if (lifetime === "long-lived") throw new Error("fakeHost: a long-lived host does not stop; delete it");
      for (const { running } of named(name)) if ("suspend" in running) await running.suspend();
    },
    /** Each `/wake` the runtimes of the host `name` (default: every one) answered, across its stops, in order. */
    wakes(name?: string): Wake[] {
      return named(name).flatMap(({ running }) => running.wakes ?? []);
    },
    /** Stops every host it started. */
    async close() {
      for (const id of hosts.keys()) await remove(id);
    },
  };
}

/**
 * A `StartHost` for `fakeHost` that runs `config` in this process, as `sanoma serve` does: a
 * worker on `databaseUrl` under a supervisor (`superviseWorker`, given `options`), which stops
 * itself when idle with a wakeup declared, and a server that answers `/healthz`, and
 * `GET /wake` with 204, each one recorded as the running host's `wakes` and handed to
 * the supervisor (the app itself needs its build, which this package does not).
 */
export function inProcessHost(config: SanomaConfig, databaseUrl: string, options: SupervisorOptions = {}): StartHost {
  return async ({ port }) => {
    const worker = await superviseWorker(testWorkerConfig(config, databaseUrl), { quiet: true, ...options });
    const wakes: Wake[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://host");
      if (url.pathname === "/healthz") return void res.writeHead(200).end("ok\n");
      if (url.pathname !== "/wake" || req.method !== "GET") return void res.writeHead(404).end();
      wakes.push({ at: new Date() });
      worker.wake().catch((err: unknown) => console.warn(`a wake failed: ${errorMessage(err)}`));
      res.writeHead(204, { "cache-control": "no-store" }).end();
    });
    const url = await listen(server, port).catch(async (err: unknown) => {
      await worker.stop();
      throw err;
    });
    return {
      url,
      wakes,
      async stop() {
        await new Promise<void>((done) => server.close(() => done()));
        await worker.stop();
      },
    };
  };
}

/**
 * A bare git repository in a temporary directory, as a host's source: `url` (a `file:` URL),
 * `commit()` pushes a new commit to `main` and returns its revision, `remove()` deletes it.
 */
export function testRepository() {
  const dir = mkdtempSync(join(tmpdir(), "sanoma-source-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Sanoma", "-c", "user.email=test@sanoma.invalid", ...args], {
      cwd: join(dir, "work"),
      encoding: "utf8",
    }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(dir, "source.git")]);
  execFileSync("git", ["init", "-q", "-b", "main", join(dir, "work")]);
  const url = pathToFileURL(join(dir, "source.git")).href;
  let n = 0;
  const commit = async () => {
    writeFileSync(join(dir, "work", "change.txt"), `${++n}\n`);
    git("add", "change.txt");
    git("commit", "-q", "-m", `Change ${n}`);
    git("push", "-q", url, "HEAD:refs/heads/main");
    return git("rev-parse", "HEAD");
  };
  return { url, git, commit, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
