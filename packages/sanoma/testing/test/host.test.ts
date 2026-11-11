import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallContext,
  type HostLifetime,
  memoryLedger,
  memorySecrets,
  resolveRevision,
  SanomaClient,
  type SanomaConfig,
} from "sanoma/workflows";
import { writeLockfile } from "sanoma/workflows/describe";
import { secret } from "sanoma/resources";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl } from "../src/index.ts";
import {
  checkHost,
  fakeHost,
  fakeHostType,
  hostCheck,
  hostCheckWorkflows,
  inProcessHost,
  type Running,
  type StartHost,
  testRepository,
} from "../src/host.ts";

// Needs Postgres: `pnpm db:up`. The conformance kit against a host in this process: its worker
// stops and starts through the host type's own operations, and drift is the built-in workflow
// over a data file that declares the host, bound in the lockfile. Once long-lived, once behind
// the proxy of a host that stops on exit, its runtime ending once its worker stopped itself (the
// environment names a wake route, a stub that takes each registration), which the checks of a
// stopping host add to; and that one again with a hostname, which never resolves, so the kit must
// reach the host at its wakeUrl.
const key = "kit-secret-value-that-never-leaks";

const call = (opId: string): CallContext => ({
  idempotencyKey: opId,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets({ HOST_KEY: key }),
});

describe.each<{ title: string; lifetime: HostLifetime; database: string; hostname?: string }>([
  { title: "long-lived", lifetime: "long-lived", database: "host_kit" },
  { title: "stops-on-exit", lifetime: "stops-on-exit", database: "host_kit_stopping" },
  {
    title: "stops-on-exit, with a hostname",
    lifetime: "stops-on-exit",
    database: "host_kit_hostname",
    hostname: "app.example.invalid",
  },
])("the host conformance kit, $title", ({ lifetime, database, hostname }) => {
  const databaseUrl = testDatabaseUrl(database);
  const repo = testRepository();
  const root = mkdtempSync(join(tmpdir(), "sanoma-host-kit-"));
  const declared = { name: "company", source: repo.url, ref: "main", port: 0, ...(hostname && { hostname }) };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  // A worker that stops itself soon once idle, so the checks of its end take seconds.
  const host = fakeHost((input) => inProcessHost(config, databaseUrl, { stopCheckMs: 200 })(input), { lifetime });
  // The host's wake route, as the environment names it: it takes each registration.
  const wakeRoute = createServer((_, res) => void res.writeHead(204).end());
  config.connectors.push(host.connector);
  const op = (name: string) => (input: object) => host.driver.ops[`app.${name}`]!(input, call(`testhost.app.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
    if (lifetime !== "long-lived") {
      await new Promise<void>((done) => wakeRoute.listen(0, "127.0.0.1", done));
      vi.stubEnv("SANOMA_HOST_URL", `http://127.0.0.1:${(wakeRoute.address() as AddressInfo).port}`);
      vi.stubEnv("SANOMA_WAKEUP_TOKEN", "swi_host-kit");
    }
    await repo.commit();
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { testhost } from "@sanoma-ai/testing-host/resources";\n\n` +
        `export const app = testhost.app(${JSON.stringify(declared)});\n\nexport default [app];\n`,
    );
    writeLockfile(root, { "resources/hosts.ts#app": { type: "testhost.app", id: "company" } });
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    await client?.close();
    await host.close();
    vi.unstubAllEnvs();
    wakeRoute.close();
    repo.remove();
    rmSync(root, { recursive: true, force: true });
  });

  /** Apply, as it will run for a host: the revision from the ref, then a plan, then the change it names. */
  async function apply() {
    const desired = { ...declared, secrets: { SANOMA_SECRETS_KEY: secret("HOST_KEY") }, revision: "" };
    desired.revision = await resolveRevision(repo.url, declared.ref);
    const now = (await op("read")({ id: declared.name })) as { gone: boolean; state?: Record<string, unknown> };
    const plan = (await op("plan")({ id: declared.name, ...now, desired })) as { action: string };
    if (plan.action === "none") return now.state!;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: declared.name, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it("passes every check against a host in this process", { timeout: 120_000 }, async () => {
    const results = await checkHost({
      type: host.type,
      apply,
      stop: async () => void (await op("delete")({ id: declared.name })),
      ...(lifetime !== "long-lived" && { suspend: () => host.stop(), running: async () => host.running() }),
      client,
      secrets: [key],
      commit: repo.commit,
      async drift() {
        const report = await client.driftReport(await client.drift({ startedBy: { id: "kit" } }));
        return report.resources.find((r) => r.id === "resources/hosts.ts#app")!;
      },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "the app answers on its port", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "the next store read sees a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      ...(lifetime === "long-lived"
        ? []
        : [
            { name: "a queued run drains after a stop and a wake", ok: true },
            { name: "a sleep that ends while stopped continues after a wake", ok: true },
            { name: "the host stops when its worker is idle", ok: true },
            { name: "a run queued while the worker is stopping still runs", ok: true },
          ]),
      { name: "two deploys at once leave one revision, the loser at once", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
  });
});

/** A runtime that answers each request with the revision and secret it was started with; `starts` counts them. */
function stub() {
  const starts: Parameters<StartHost>[0][] = [];
  const start: StartHost = async (input) => {
    starts.push(input);
    const server = createServer((_, res) => res.end(`${input.revision} ${input.secrets.KEY}`));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const running: Running = {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      stop: () => new Promise<void>((done) => server.close(() => done())),
    };
    return running;
  };
  return { starts, start };
}

describe("fakeHost's lifetime", () => {
  const desired = { name: "company", source: "file:///source.git", ref: "main", port: 0, revision: "abc" };
  const create = async (host: ReturnType<typeof fakeHost>) => {
    const done = await host.driver.ops["app.create"]!(
      { desired: { ...desired, secrets: { KEY: secret("HOST_KEY") } } },
      call("testhost.app.create"),
    );
    return (done as { state: { url: string } }).state.url;
  };

  it("is long-lived by default, and refuses to stop", async () => {
    const host = fakeHost(stub().start);
    expect(host.type).toBe(fakeHostType);
    expect(host.type.host?.capabilities.lifetime).toBe("long-lived");
    await expect(host.stop()).rejects.toThrow("a long-lived host does not stop");
  });

  it("stops-on-exit: keeps its URL across a stop, and the next request starts it again as it was", async () => {
    const { starts, start } = stub();
    const host = fakeHost(start, { lifetime: "stops-on-exit" });
    try {
      expect(host.type.host?.capabilities.lifetime).toBe("stops-on-exit");
      const url = await create(host);
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      await host.stop();
      expect(host.running()).toBe(false);
      expect(starts).toHaveLength(1);
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      expect(starts).toHaveLength(2);
      expect(starts[1]).toEqual(starts[0]);
    } finally {
      await host.close();
    }
  });

  it("stops-on-exit: ends with its runtime, and the next request starts it again", async () => {
    const { starts, start } = stub();
    let exit!: () => void;
    const host = fakeHost(
      async (input) => {
        const running = await start(input);
        // Its process exits: the server closed, then the end told.
        const exited = new Promise<void>((resolve) => (exit = () => void running.stop().then(resolve)));
        return { ...running, exited };
      },
      { lifetime: "stops-on-exit" },
    );
    try {
      const url = await create(host);
      expect(host.running()).toBe(true);
      exit();
      await vi.waitFor(() => expect(host.running()).toBe(false));
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      expect(starts).toHaveLength(2);
      expect(host.running()).toBe(true);
    } finally {
      await host.close();
    }
  });
});
