import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  type DriftResult,
  errorMessage,
  isEnded,
  type PlanAction,
  type Resource,
  resolveSecrets,
  type SanomaClient,
  type SanomaConfig,
  withSetup,
} from "@sanoma-ai/workflows";
import { z } from "zod";
import { waitFor } from "./build.ts";
import { startTestWorker } from "./index.ts";

// The conformance kit for the `Host` contract: whether a host runs the company as the runtime
// needs. `checkHost` drives a declared host through callbacks (apply it, stop it, commit to its
// source, check it for drift) and a client on its database, and reports each check. The host's
// config carries `hostCheck` and `hostCheckWorkflows`, which the checks start runs of.
// `fakeHost` is a host in this process, for the kit's own tests and for building against the
// contract before a real host lands.

type State = Record<string, unknown>;

/** The variable the credential check sets: the host's worker must hear the change over `LISTEN`. */
export const HOST_CHECK_CREDENTIAL = "HOST_CHECK_TOKEN";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

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
  { probe: { digest: async () => ({ digest: digest(process.env[HOST_CHECK_CREDENTIAL] ?? "") }) } },
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
  type: Resource;
  /** Makes the host match its declaration, its revision what its ref names now; returns its state. */
  apply(): Promise<State>;
  /** Stops the host through its resource's operations (its `delete`); `apply` starts it again. */
  stop(): Promise<void>;
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

/**
 * Runs the conformance checks against a host, in order, each on its own (one failing goes on to
 * the next): the app answers on its port, a queued run drains, `LISTEN` hears a credential
 * change, a sleep survives a restart, a new commit shows as drift that apply clears, and no
 * secret is in the ledger. Leaves the host applied, and its check's credential cleared.
 */
export async function checkHost(host: HostUnderTest): Promise<HostCheck[]> {
  const { type, client, timeoutMs = 60_000 } = host;
  const spec = type.host;
  if (!spec) throw new Error(`${type.vendor}.${type.type} does not meet the Host contract: it has no host`);
  const credential = randomBytes(18).toString("base64url");
  const results: HostCheck[] = [];
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
  const ended = (runId: string) =>
    waitFor(
      () => client.run(runId),
      (r) => r !== undefined && isEnded(r.status),
      timeoutMs,
    );
  const finish = async (runId: string) => {
    const run = await ended(runId);
    if (run?.status !== "finished") throw new Error(`run ${runId} ended ${run?.status}: ${run?.error}`);
  };

  // A value an earlier check left, under another key, would stop the host's worker from starting.
  await client.clearCredential(HOST_CHECK_CREDENTIAL, { by: startedBy.id });
  await check("the app answers on its port", async () => {
    const outputs = spec.outputs(await host.apply());
    if (!outputs.healthy) throw new Error("its state says it is not healthy");
    const res = await fetch(new URL("/healthz", outputs.url));
    if (!res.ok) throw new Error(`${outputs.url}/healthz answered ${res.status}`);
  });
  await check("a queued run drains", async () => {
    await finish(await client.start("host-check-drain", {}, { startedBy }));
  });
  await check("LISTEN hears a credential change", async () => {
    await client.setCredential(HOST_CHECK_CREDENTIAL, credential, { by: startedBy.id });
    // The worker loads the value when it hears the change: until then a probe fails, or reads the old one.
    await waitFor(
      async () => {
        const runId = await client.start("host-check-credential", {}, { startedBy });
        const run = await ended(runId);
        return run?.status === "finished" ? ((await client.result(runId)) as { digest: string }).digest : undefined;
      },
      (seen) => seen === digest(credential),
      timeoutMs,
    );
  });
  await check("a sleep survives a restart", async () => {
    const runId = await client.start("host-check-sleep", { seconds: 2 }, { startedBy });
    await waitFor(async () => (await client.ledger(runId)).some((r) => r.type === "sleep.started"), Boolean, timeoutMs);
    await host.stop();
    await host.apply();
    await finish(runId);
  });
  await check("a new commit shows as drift that apply clears", async () => {
    const revision = await host.commit();
    const drifted = await host.drift();
    const field = drifted.fields.find((f) => f.path === spec.revision);
    if (drifted.status !== "drifted" || field?.desired !== revision) {
      throw new Error(`after a commit, drift says ${drifted.status} ${JSON.stringify(drifted.fields)}`);
    }
    await host.apply();
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

/** What `fakeHost` starts for a revision: the runtime, answering at `url`, until `stop`. */
export interface Running {
  url: string;
  stop(): Promise<void>;
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

/** The fake host's type, `testhost.app`: a host in this process, which `fakeHost` drives. */
export const fakeHostType = defineResource({
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
    capabilities: { lifetime: "long-lived", publicUrl: false, buildsFromGit: true, staticEgress: false },
    inputs: { source: "source", ref: "ref", secrets: "secrets", port: "port" },
    revision: "revision",
    outputs: (state) => ({
      url: String(state.url ?? ""),
      ...(typeof state.revision === "string" && { revision: state.revision }),
      healthy: state.running === true,
    }),
  },
});

const fakeHostOps = defineConnector(
  "testhost",
  { app: fakeHostType },
  {
    title: "Test host",
    // Only what a data file imports it from: no such package is published.
    package: "@sanoma-ai/testing-host",
  },
);

/**
 * A host in this process: `testhost.app` with a driver that runs `start` for each create and
 * update (every change is a replace, as for a container) and stops it on delete. Its state holds
 * no secret. `connector` is for a config; `driver` for calling its operations directly.
 */
export function fakeHost(start: StartHost) {
  const hosts = new Map<string, { state: Omit<z.output<typeof fakeSchema>, "secrets">; running: Running }>();
  const stateOf = (id: string) => hosts.get(id)?.state;
  const read = async ({ id }: { id: string }) => {
    const state = stateOf(id);
    return state ? { id, gone: false, state } : { id, gone: true };
  };
  const stop = async (id: string) => {
    const host = hosts.get(id);
    hosts.delete(id);
    await host?.running.stop();
  };
  const run = async (desired: Record<string, unknown>, secrets: Parameters<typeof resolveSecrets>[1]) => {
    const declared = fakeSchema.parse(await resolveSecrets(desired, secrets));
    await stop(declared.name);
    const revision = declared.revision ?? "";
    const running = await start({ port: declared.port, revision, secrets: declared.secrets ?? {} });
    const { secrets: _, ...kept } = declared;
    const state = { ...kept, revision, url: running.url, running: true };
    hosts.set(declared.name, { state, running });
    return { id: declared.name, state };
  };
  const driver = defineDriver(fakeHostOps, {
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
        await stop(id);
        return { id, gone: true as const };
      },
    },
  });
  return {
    connector: withSetup(fakeHostOps, { driver: () => driver }),
    driver,
    /** Stops every host it started. */
    async close() {
      for (const id of hosts.keys()) await stop(id);
    },
  };
}

/**
 * A `StartHost` for `fakeHost` that runs `config` in this process: a worker on `databaseUrl` and
 * a server that answers `/healthz` (the app itself needs its build, which this package does not).
 */
export function inProcessHost(config: SanomaConfig, databaseUrl: string): StartHost {
  return async ({ port }) => {
    const worker = await startTestWorker(config, { databaseUrl, quiet: true });
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/healthz" ? 200 : 404).end(req.url === "/healthz" ? "ok\n" : undefined);
    });
    await new Promise<void>((done, fail) => server.once("error", fail).listen(port, "127.0.0.1", done)).catch(
      async (err: unknown) => {
        await worker.stop();
        throw err;
      },
    );
    const { port: bound } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${bound}`,
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
