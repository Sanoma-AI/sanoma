import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as forwardRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { hostnameUrl } from "sanoma/workflows/shared";
import {
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  deriveHosts,
  type DriftResult,
  envWakeup,
  errorMessage,
  type HostFacts,
  type HostLifetime,
  isEnded,
  isSecret,
  type PlanAction,
  type Resource,
  resolveSecrets,
  type SanomaClient,
  type SanomaConfig,
  superviseWorker,
  type SupervisorOptions,
  runtimeImage,
  valueAt,
  wakeUrlOf,
  withSetup,
} from "sanoma/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import { testWorkerConfig } from "./index.ts";

// The conformance kit for the `Host` contract: whether a host runs the company as the runtime
// needs. `checkHost` drives a declared host through callbacks (apply it, stop it, commit to its
// source, check it for drift) and a client on its database, and reports each check. The host's
// config carries `hostCheck` and `hostCheckWorkflows`, which the checks start runs of.
// `fakeHost` is a host in this process, for the kit's own tests and for building against the
// contract before a real host lands: long-lived, or behind a proxy that starts it again on the
// next request after its runtime ended, as a host that scales to zero does.

type State = Record<string, unknown>;

/** The logical secret the credential check sets: the worker must read the current stored value. */
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
const hostCheckDriver = defineDriver(hostCheckOps, {
  probe: {
    digest: async (_input, call) => ({
      digest: credentialDigest((await call.secrets.get(HOST_CHECK_CREDENTIAL)) ?? ""),
    }),
  },
});

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
   * Stops the company's runtime as its platform may on its own (a crash, a restart), its URL
   * kept: the next wake starts it again. Required unless the host is `long-lived`.
   */
  suspend?(): Promise<void>;
  /**
   * Whether the company's runtime runs now, as the host's platform tells it. Required unless the
   * host is `long-lived`: one that `stops-on-exit` ends it once its worker is idle.
   */
  running?(): Promise<boolean>;
  /** A client on the host's database, its config with `hostCheck` and `hostCheckWorkflows`. */
  client: SanomaClient;
  /** The values the host was given as secrets: none may appear in a ledger record. */
  secrets: readonly string[];
  /** Makes a new commit on the host's source at its ref; returns its revision. */
  commit(): Promise<string>;
  /** A drift check's row for the host's declaration. */
  drift(): Promise<DriftResult>;
  /**
   * A page of the app, by path (`/`), for a host that answers visitors apart from the company's
   * worker: it must answer while the worker is stopped, and throughout a deploy, never with a 503.
   */
  page?: string;
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
 * Sets the check's credential to `credential` and waits until a probe run reads it through
 * the selected store, each start followed by `wake` when given (a host that stops). The host and
 * database kits' check.
 */
export async function credentialHeard(
  client: SanomaClient,
  credential: string,
  by: { id: string },
  timeoutMs: number,
  wake?: () => Promise<void>,
): Promise<void> {
  await client.setSecret(HOST_CHECK_CREDENTIAL, credential, { by: by.id });
  await waitFor(
    async () => {
      const runId = await client.start("host-check-credential", {}, { startedBy: by });
      await wake?.();
      const run = await runEnded(client, runId, timeoutMs);
      return run?.status === "finished" ? ((await client.result(runId)) as { digest: string }).digest : undefined;
    },
    (seen) => seen === credentialDigest(credential),
    timeoutMs,
  );
}

/**
 * Runs the conformance checks against a host, in order, each on its own (one failing goes on to
 * the next): the app answers on its port, a queued run drains, the next store read sees a credential
 * change, a sleep survives a restart, a new commit shows as drift that apply clears, and no
 * secret is in the ledger. A host that stops (`stops-on-exit`) has each start followed by a
 * `/wake`, as the app's own writes are (`drift` woken until it ends), and is also checked for what a wake starts again
 * (`suspend`, then a `/wake`): a run queued while it was stopped drains, and a sleep that ended
 * while it was stopped continues; and for its end: it stops once its worker is idle (`running`),
 * and a run queued while the worker stops (as the worker records `stopped_at`) still runs. With a
 * `page`, the page answers while the host is stopped, and every ask of it answers 200 throughout a
 * deploy of a new commit. Leaves the host applied, and its check's credential cleared.
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
  const stops = spec.capabilities.lifetime !== "long-lived";
  // A request, as a wakeup sends it, until the host answers 204 (one starting may answer 503
  // first); none to a host that never stops.
  const wake = async () => {
    if (!stops) return;
    const at = new URL("/wake", wakeUrlOf(spec.outputs(applied)));
    const answer = () => fetch(at).then((res) => res.status, errorMessage);
    await waitFor(answer, (status) => status === 204, timeoutMs);
  };
  // A run started as the app starts one: on a host that stops, a wake after the write.
  const start = async (workflow: string, input: object) => {
    const runId = await client.start(workflow, input, { startedBy });
    await wake();
    return runId;
  };
  // What a callback runs on the host's own worker (its drift run), on a host that stops: woken
  // every second until it ends, so a wake follows its write as the app's would.
  const awake = async <T>(work: Promise<T>): Promise<T> => {
    if (!stops) return work;
    const done = new AbortController();
    const waking = (async () => {
      while (!done.signal.aborted) {
        await wake().catch(() => undefined);
        await delay(1_000, undefined, { signal: done.signal }).catch(() => undefined);
      }
    })();
    try {
      return await work;
    } finally {
      done.abort();
      await waking;
    }
  };

  // A value an earlier check left, under another key, would stop the host's worker from starting.
  await client.clearSecret(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
  await check("the app answers on its port", async () => {
    const outputs = spec.outputs(await apply());
    if (!outputs.healthy) throw new Error("its state says it is not healthy");
    // Where the host's own process answers, which never waits on a hostname's DNS.
    const at = wakeUrlOf(outputs);
    const res = await fetch(new URL("/healthz", at));
    if (!res.ok) throw new Error(`${at}/healthz answered ${res.status}`);
  });
  await check("a queued run drains", async () => {
    await finish(await start("host-check-drain", {}));
  });
  await check("the next store read sees a credential change", () =>
    credentialHeard(client, credential, startedBy, timeoutMs, wake),
  );
  await check("a sleep survives a restart", async () => {
    const runId = await start("host-check-sleep", { seconds: 2 });
    await waitFor(async () => (await client.ledger(runId)).some((r) => r.type === "sleep.started"), Boolean, timeoutMs);
    await host.stop();
    await apply();
    await finish(runId);
  });
  if (stops) {
    const suspend = async () => {
      if (!host.suspend) throw new Error(`a host that is ${spec.capabilities.lifetime} needs suspend to be checked`);
      await host.suspend();
    };
    const running = async () => {
      if (!host.running) throw new Error(`a host that is ${spec.capabilities.lifetime} needs running to be checked`);
      return host.running();
    };
    await check("a queued run drains after a stop and a wake", async () => {
      await suspend();
      await finish(await start("host-check-drain", {}));
    });
    await check("a sleep that ends while stopped continues after a wake", async () => {
      const runId = await start("host-check-sleep", { seconds: 3 });
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
    await check("the host stops when its worker is idle", async () => {
      await wake();
      await waitFor(running, (up) => !up, timeoutMs);
    });
    await check("a run queued while the worker is stopping still runs", async () => {
      // The worker records `stopped_at` once its last idle check passed, then stops and exits: a run
      // queued right then was not seen by that check, and its wake must win, or start the host again.
      const pool = await client.pool();
      const stoppedAt = async () =>
        (
          await pool.query<{ at: Date | null }>("select stopped_at as at from sanoma_wakeup where id = 1")
        ).rows[0]?.at?.getTime() ?? 0;
      const before = await stoppedAt();
      await wake();
      await waitFor(stoppedAt, (at) => at > before, timeoutMs, 5);
      await finish(await start("host-check-drain", {}));
    });
    if (host.page !== undefined) {
      const page = new URL(host.page, wakeUrlOf(spec.outputs(applied)));
      await check("a page of the app answers while the container is stopped", async () => {
        await suspend();
        const res = await fetch(page);
        await res.body?.cancel();
        if (res.status !== 200) throw new Error(`${page} answered ${res.status} while stopped`);
      });
    }
  }
  if (host.page !== undefined) {
    await check("a deploy never answers 503 to a visitor", async () => {
      const page = new URL(host.page!, wakeUrlOf(spec.outputs(applied)));
      await host.commit();
      const seen = new Map<number | string, number>();
      const deploying = new AbortController();
      const asking = (async () => {
        while (!deploying.signal.aborted) {
          const status = await fetch(page).then(async (res) => (await res.body?.cancel(), res.status), errorMessage);
          seen.set(status, (seen.get(status) ?? 0) + 1);
          await delay(20);
        }
      })();
      try {
        await apply();
      } finally {
        deploying.abort();
        await asking;
      }
      const other = [...seen].filter(([status]) => status !== 200);
      if (other.length) {
        throw new Error(
          `asked during the deploy, ${page} answered ${other.map(([s, n]) => `${s} (${n}×)`).join(", ")}`,
        );
      }
      if (!seen.size) throw new Error(`${page} was never asked during the deploy`);
    });
  }
  await check("a new commit shows as drift that apply clears", async () => {
    const revision = await host.commit();
    const drifted = await awake(host.drift());
    const field = drifted.fields.find((f) => f.path === spec.revision);
    if (drifted.status !== "drifted" || field?.desired !== revision) {
      throw new Error(`after a commit, drift says ${drifted.status} ${JSON.stringify(drifted.fields)}`);
    }
    await apply();
    const cleared = await awake(host.drift());
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
  await client.clearSecret(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
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
  /** Settles once the runtime ended on its own (its process exited), for one that may. */
  exited?: Promise<void>;
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
  /** The app's hostname, reported as its `url` (`https://<hostname>`) but not served: the fake answers on this machine only, its `wakeUrl`. */
  hostname: z.string().optional(),
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
      inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port", hostname: "hostname" },
      revision: "revision",
      outputs: (state) => ({
        url: typeof state.hostname === "string" ? hostnameUrl(state.hostname) : String(state.url ?? ""),
        // Its wakeup reaches it where it answers, on this machine.
        ...(typeof state.hostname === "string" && typeof state.url === "string" && { wakeUrl: state.url }),
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
}

/** A host that stops: the proxy at its URL, and the runtime behind it it starts on a request. */
interface Proxy extends Running {
  wakes: readonly Wake[];
  /** True while a runtime is starting or runs behind it. */
  readonly running: boolean;
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
 * request starts it again when it is stopped or ended on its own (`Running.exited`), one start at
 * a time, and is forwarded to it.
 */
async function proxy(begin: () => Promise<Running>, port: number): Promise<Proxy> {
  let runtime: Promise<Running> | undefined;
  let stopping: Promise<void> = Promise.resolve();
  // Every runtime it started, for the wakes each answered.
  const runs: Running[] = [];
  const up = () => {
    if (runtime) return runtime;
    const starting: Promise<Running> = stopping
      .then(() => begin())
      .then(
        (started) => {
          runs.push(started);
          // The host ends with its runtime: the next request starts another.
          void started.exited?.then(() => {
            if (runtime === starting) runtime = undefined;
          });
          return started;
        },
        (err: unknown) => {
          runtime = undefined;
          throw err;
        },
      );
    return (runtime = starting);
  };
  const suspend = async () => {
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
  const server = createServer((req, res) => {
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
  return {
    url,
    get wakes() {
      return runs.flatMap((started) => started.wakes ?? []);
    },
    get running() {
      return runtime !== undefined;
    },
    suspend,
    async replace(next) {
      await suspend();
      begin = next;
      await up();
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
 * Long-lived (the default), its URL is the runtime's own. Otherwise (`stops-on-exit`) its URL is
 * a proxy on the declared port in front of the runtime: the runtime ending on its own (`exited`)
 * or `stop` ends it while the proxy stays, and the next request starts it again, at the same
 * revision with the same secrets, and is forwarded to it. A replace keeps the proxy.
 */
export function fakeHost(start: StartHost, { lifetime = "long-lived" }: FakeHostOptions = {}) {
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
      running = lifetime === "long-lived" ? await begin() : await proxy(begin, declared.port);
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
        // A hostname left out is compared too: removing it is a change.
        const replace = ["source", "ref", "port", "revision", "hostname"].filter(
          (f) => (f in desired || f === "hostname") && desired[f] !== state[f],
        );
        // A hostname left out is gone from the planned state too.
        const { hostname: _hostname, ...was } = state;
        return { action: replace.length ? "replace" : "none", planned: { ...was, ...planned }, unknown: [], replace };
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
     * Stops the runtime behind the URL of the host `name` (default: every one), as its platform
     * may, the URL kept: the next request starts it again. Refused for a long-lived host.
     */
    async stop(name?: string) {
      if (lifetime === "long-lived") throw new Error("fakeHost: a long-lived host does not stop; delete it");
      for (const { running } of named(name)) if ("suspend" in running) await running.suspend();
    },
    /** True while a runtime runs (or starts) behind the URL of the host `name` (default: any). */
    running: (name?: string) => named(name).some(({ running }) => !("suspend" in running) || running.running),
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
 * A `StartHost` for `fakeHost` that runs `config` in this process, as `sanoma worker` does: a
 * worker on `databaseUrl` under a supervisor (`superviseWorker`, given `options`), which stops
 * itself when idle with a wakeup, and a server that answers `/healthz`, and `GET /wake` with 204,
 * each one recorded as the running host's `wakes` and handed to the supervisor (the app itself
 * needs its build, which this package does not). On a host that starts it again (this process's
 * environment names the host's wake route, `envWakeup`), it ends once its supervisor has no worker
 * (`onEnded`: it stopped itself, or a fresh one failed to start) (`exited`), its server closed
 * first, so a wake after that is refused, not lost.
 */
export function inProcessHost(config: SanomaConfig, databaseUrl: string, options: SupervisorOptions = {}): StartHost {
  return async ({ port }) => {
    const exits = envWakeup(process.env) !== undefined;
    let ending: Promise<void> | undefined;
    const exited = Promise.withResolvers<void>();
    // The server closed at once, before the worker is stopped.
    const end = () =>
      (ending ??= (async () => {
        const closed = new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
        await closed;
        await worker.stop();
      })());
    const worker = await superviseWorker(testWorkerConfig(config, databaseUrl), {
      quiet: true,
      ...options,
      onEnded(failure) {
        options.onEnded?.(failure);
        if (exits) void end().then(exited.resolve);
      },
    });
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
    return { url, wakes, ...(exits && { exited: exited.promise }), stop: end };
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

/** What `checkDerivedHost` derives a host from: a fixed set of facts, as an apply would read them. */
const DERIVED_FACTS = {
  version: "9.9.9",
  origin: "https://github.com/acme/company.git",
  domains: { www: "www.acme.example" },
  builtInStore: true,
  githubApp: ["SANOMA_GITHUB_APP_ID"],
  sourceKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC host-check",
} as const;

/**
 * The conformance checks for a host type that derives (`HostSpec.derives`), offline: a declaration
 * of its decisions alone (`name`, and `database` naming a declared database) is filled by apply
 * (`deriveHosts`) with each derived value, which its type then parses: the installed sanoma's
 * runtime image, the app's `origin` as its source (and, when its type takes `inputs.name`, its
 * name left out, the repository's), the public sites' domains, and (unless it binds
 * its own bootstrap) its secrets as markers only, its database's URL among them; a declaration
 * that writes its secrets or its domains is refused. `name` is a valid name for the type.
 */
export function checkDerivedHost(
  type: Pick<Resource, "vendor" | "type" | "host" | "fields" | "schema">,
  { name = "acme" }: { name?: string } = {},
): HostCheck[] {
  const spec = type.host;
  if (!spec?.derives) throw new Error(`${type.vendor}.${type.type} does not derive: it has no host.derives`);
  const { inputs } = spec;
  const results: HostCheck[] = [];
  const check = (checkName: string, run: () => void) => {
    try {
      run();
      results.push({ name: checkName, ok: true });
    } catch (err) {
      results.push({ name: checkName, ok: false, error: errorMessage(err) });
    }
  };
  const file = "resources/sanoma/infra.ts";
  const at = (exported: string) => ({ file, export: exported });
  const id = `${file}#host`;
  const store = {
    id: `${file}#store`,
    file,
    vendor: "db",
    type: "project",
    name: "store",
    at: at("store"),
    desired: {},
    refs: {},
  };
  const host = {
    id,
    file,
    vendor: type.vendor,
    type: type.type,
    name,
    at: at("host"),
    desired: { name, ...(inputs.database && { [inputs.database]: "store" }) } as Record<string, unknown>,
    refs: inputs.database ? { [inputs.database]: store.id } : ({} as Record<string, string>),
  };
  const facts: HostFacts = { ...DERIVED_FACTS, carried: new Map([[type.vendor, ["HOST_CHECK_VENDOR_TOKEN"]]]) };
  const types = new Map([[`${type.vendor}.${type.type}`, type as Resource]]);
  const resources = [store, host];
  const problems = deriveHosts(resources, types, {}, facts);
  const { desired } = host;

  check("its decisions alone derive with no problem", () => {
    if (problems.length) throw new Error(problems.map((p) => p.message).join("; "));
  });
  if (inputs.image !== undefined) {
    check("its image is the installed sanoma's runtime image", () => {
      const image = valueAt(desired, inputs.image!);
      if (image !== runtimeImage(DERIVED_FACTS.version)) throw new Error(`its image is ${JSON.stringify(image)}`);
    });
  }
  check("its source is the repository the app runs from", () => {
    const source = valueAt(desired, inputs.source);
    if (source !== DERIVED_FACTS.origin) throw new Error(`its source is ${JSON.stringify(source)}`);
  });
  if (inputs.name !== undefined) {
    check("its name, left out, is its repository's", () => {
      const unnamed = { ...host, desired: { ...host.desired }, refs: { ...host.refs } };
      delete unnamed.desired[inputs.name!];
      deriveHosts([store, unnamed], types, {}, facts);
      const named = valueAt(unnamed.desired, inputs.name!);
      if (named !== "company") throw new Error(`its name is ${JSON.stringify(named)}`);
    });
  }
  check("its ref is left to its repository's default branch", () => {
    if (valueAt(desired, inputs.ref) != null)
      throw new Error(`its ref is ${JSON.stringify(valueAt(desired, inputs.ref))}`);
  });
  if (inputs.domains !== undefined) {
    check("its domains are the public sites'", () => {
      const domains = valueAt(desired, inputs.domains!);
      if (JSON.stringify(domains) !== JSON.stringify(DERIVED_FACTS.domains))
        throw new Error(`its domains are ${JSON.stringify(domains)}`);
    });
  }
  if (!spec.bindsBootstrap && inputs.secrets !== undefined) {
    check("its secrets are markers, its database's URL among them", () => {
      const secrets = (valueAt(desired, inputs.secrets!) ?? {}) as Record<string, unknown>;
      const plain = Object.entries(secrets).filter(([, value]) => !isSecret(value));
      if (plain.length) throw new Error(`${plain.map(([key]) => key).join(", ")} is no secret(...)`);
      for (const needed of ["SANOMA_DATABASE_URL", "SANOMA_SIGNING_KEY", "HOST_CHECK_VENDOR_TOKEN"]) {
        if (!(needed in secrets)) throw new Error(`it is not given ${needed}`);
      }
    });
    check("a declaration that writes its secrets is refused", () => {
      const declare = type as unknown as (desired: State) => unknown;
      // Valid but for its secrets, so the refusal is of them.
      declare({ name });
      let refusal = "";
      try {
        declare({ name, [inputs.secrets!]: { SANOMA_DATABASE_URL: "postgres://host-check" } });
      } catch (err) {
        refusal = errorMessage(err);
      }
      if (!refusal.includes(inputs.secrets!))
        throw new Error(`it took \`${inputs.secrets}\`${refusal && `: ${refusal}`}`);
    });
  }
  check("its type parses what apply derives, its secrets resolved", () => {
    // As its driver parses it: each marker resolved (`resolveSecrets`), the revision and ref resolved.
    const resolved = structuredClone(desired);
    const secrets = inputs.secrets === undefined ? undefined : (valueAt(desired, inputs.secrets) as State | undefined);
    if (secrets && inputs.secrets) {
      const keys = inputs.secrets.split(".");
      let holder = resolved;
      for (const key of keys.slice(0, -1)) holder = holder[key] as State;
      holder[keys.at(-1)!] = Object.fromEntries(Object.keys(secrets).map((key) => [key, "host-check-value"]));
    }
    const parsed = type.schema.safeParse({ ...resolved, [spec.revision]: "0".repeat(40), [inputs.ref]: "main" });
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  });
  return results;
}

/**
 * The check that no secret's value is in what the runtime writes or shows about a host: each of
 * `values` (at least 8 characters) against each of `texts`, by what it is (a declaration, a plan,
 * a ledger entry, a page). The host kit's last check, for a host that derives too.
 */
export function noSecretIn(values: readonly string[], texts: Readonly<Record<string, string>>): HostCheck {
  const name = "no secret value is in a declaration, plan, ledger entry or page";
  const long = values.filter((value) => value.length >= 8);
  const leaks = Object.entries(texts).filter(([, text]) => long.some((value) => text.includes(value)));
  return leaks.length
    ? { name, ok: false, error: `a secret's value is in ${leaks.map(([where]) => where).join(", ")}` }
    : { name, ok: true };
}
