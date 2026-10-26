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
} from "@sanoma-ai/workflows";
import { writeLockfile } from "@sanoma-ai/workflows/describe";
import { secret } from "@sanoma-ai/workflows/resources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// the proxy of a host that stops, which the two checks of a stopping host add to.
const key = "kit-secret-value-that-never-leaks";

const call = (opId: string): CallContext => ({
  idempotencyKey: opId,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets({ HOST_KEY: key }),
});

describe.each<[HostLifetime, string]>([
  ["long-lived", "host_kit"],
  ["stops-when-quiet", "host_kit_stopping"],
])("the host conformance kit, %s", (lifetime, database) => {
  const databaseUrl = testDatabaseUrl(database);
  const repo = testRepository();
  const root = mkdtempSync(join(tmpdir(), "sanoma-host-kit-"));
  const declared = { name: "company", source: repo.url, ref: "main", port: 0 };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const host = fakeHost((input) => inProcessHost(config, databaseUrl)(input), { lifetime });
  config.connectors.push(host.connector);
  const op = (name: string) => (input: object) => host.driver.ops[`app.${name}`]!(input, call(`testhost.app.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
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

  it("passes every check against a host in this process", async () => {
    const results = await checkHost({
      type: host.type,
      apply,
      stop: async () => void (await op("delete")({ id: declared.name })),
      ...(lifetime !== "long-lived" && { suspend: () => host.stop() }),
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
      { name: "LISTEN hears a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      ...(lifetime === "long-lived"
        ? []
        : [
            { name: "a queued run drains after a stop and a wake", ok: true },
            { name: "a sleep that ends while stopped continues after a wake", ok: true },
          ]),
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

  it("is long-lived by default, and refuses to stop or to go quiet", async () => {
    const host = fakeHost(stub().start);
    expect(host.type).toBe(fakeHostType);
    expect(host.type.host?.capabilities.lifetime).toBe("long-lived");
    await expect(host.stop()).rejects.toThrow("a long-lived host does not stop");
    expect(() => fakeHost(stub().start, { lifetime: "stops-on-exit", quietAfterMs: 10 })).toThrow(
      "quietAfterMs is for a host that stops-when-quiet, not one that is stops-on-exit",
    );
  });

  it("stops-on-exit: keeps its URL across a stop, and the next request starts it again as it was", async () => {
    const { starts, start } = stub();
    const host = fakeHost(start, { lifetime: "stops-on-exit" });
    try {
      expect(host.type.host?.capabilities.lifetime).toBe("stops-on-exit");
      const url = await create(host);
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      await host.stop();
      expect(starts).toHaveLength(1);
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      expect(starts).toHaveLength(2);
      expect(starts[1]).toEqual(starts[0]);
    } finally {
      await host.close();
    }
  });

  it("stops-when-quiet: stops by itself once no request is open for quietAfterMs", async () => {
    const { starts, start } = stub();
    const host = fakeHost(start, { lifetime: "stops-when-quiet", quietAfterMs: 100 });
    try {
      expect(host.type.host?.capabilities.lifetime).toBe("stops-when-quiet");
      const url = await create(host);
      await fetch(url);
      await fetch(url);
      expect(starts).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await (await fetch(url)).text()).toBe(`abc ${key}`);
      expect(starts).toHaveLength(2);
    } finally {
      await host.close();
    }
  });
});
