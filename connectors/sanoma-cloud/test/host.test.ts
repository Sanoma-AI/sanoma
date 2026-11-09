import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "sanoma/testing";
import { checkHost, hostCheck, hostCheckWorkflows, inProcessHost, testRepository } from "sanoma/testing/host";
import {
  type CallContext,
  memoryLedger,
  memorySecrets,
  resolveRevision,
  SanomaClient,
  type SanomaConfig,
  withSetup,
} from "sanoma/workflows";
import { writeLockfile } from "sanoma/workflows/describe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { host, cloudOps } from "../src/connector.ts";
import { fakeCloud } from "../src/fake.ts";

// Needs Postgres: `pnpm db:up`. The Host contract's conformance kit against `cloud.host` on
// the fake: the company runs in this process behind its address, ending once its worker is idle
// (its environment names a wake route, a stub that takes each registration, as the Cloud's Worker
// does). The host binds its own bootstrap, so it is given no secrets. Drift is the built-in
// workflow over a data file that declares the host, bound in the lockfile.

let n = 0;
const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${++n}`,
  runId: "kit",
  opId,
  attempt: 1,
  secrets: memorySecrets(),
});

describe("cloud.host meets the Host contract on the fake", () => {
  const databaseUrl = testDatabaseUrl("sanoma_cloud_host");
  const repo = testRepository();
  const root = mkdtempSync(join(tmpdir(), "sanoma-cloud-host-"));
  const declared = { name: "company", source: repo.url, ref: "main" };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const fake = fakeCloud({
    // It stops itself soon once idle, so the checks of its end take seconds.
    start: ({ revision }) =>
      inProcessHost(config, databaseUrl, { stopCheckMs: 500 })({ port: 0, revision, secrets: {} }),
  });
  const wakeRoute = createServer((_, res) => void res.writeHead(204).end());
  config.connectors.push(withSetup(cloudOps, { driver: () => fake.driver }));
  const op = (name: string) => (input: object) => fake.driver.ops[`host.${name}`]!(input, call(`cloud.host.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
    await new Promise<void>((done) => wakeRoute.listen(0, "127.0.0.1", done));
    vi.stubEnv("SANOMA_HOST_URL", `http://127.0.0.1:${(wakeRoute.address() as AddressInfo).port}`);
    vi.stubEnv("SANOMA_WAKEUP_TOKEN", "swi_cloud-kit");
    await repo.commit();
    mkdirSync(join(root, "resources"));
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";\n\n` +
        `export const host = cloud.host(${JSON.stringify(declared)});\n\nexport default [host];\n`,
    );
    writeLockfile(root, { "resources/hosts.ts#host": { type: "cloud.host", id: declared.name } });
    client = await SanomaClient.connect(config);
  });

  afterAll(async () => {
    await client?.close();
    await fake.close();
    vi.unstubAllEnvs();
    wakeRoute.close();
    repo.remove();
    rmSync(root, { recursive: true, force: true });
  });

  /** Apply, as it runs for a host: the revision from the ref, then a plan, then the change it names. */
  async function apply() {
    const desired = { ...declared, revision: await resolveRevision(repo.url, declared.ref) };
    const plan = (await op("plan")({ id: declared.name, desired })) as { action: string };
    if (plan.action === "none")
      return ((await op("read")({ id: declared.name })) as { state: Record<string, unknown> }).state;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: declared.name, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it("passes every check, the ones of a host that stops among them", { timeout: 300_000 }, async () => {
    const results = await checkHost({
      type: host,
      apply,
      stop: async () => void (await op("delete")({ id: declared.name })),
      suspend: () => fake.stop(declared.name),
      running: async () => fake.running(declared.name),
      client,
      secrets: [],
      commit: repo.commit,
      async drift() {
        const report = await client.driftReport(await client.drift({ startedBy: { id: "kit" } }));
        return report.resources.find((r) => r.id === "resources/hosts.ts#host")!;
      },
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "the app answers on its port", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "the next store read sees a credential change", ok: true },
      { name: "a sleep survives a restart", ok: true },
      { name: "a queued run drains after a stop and a wake", ok: true },
      { name: "a sleep that ends while stopped continues after a wake", ok: true },
      { name: "the host stops when its worker is idle", ok: true },
      { name: "a run queued while the worker is stopping still runs", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
    // The company kept its address across a close and a sign-up, and its host runs the last commit.
    expect(Object.keys(fake.state.companies)).toEqual(["company"]);
    expect(fake.state.companies.company!.host?.revision).toBe(await resolveRevision(repo.url, "main"));
  });

  it("is a host that binds its own bootstrap, and takes no secrets", () => {
    expect(host.host).toMatchObject({
      bindsBootstrap: true,
      capabilities: { lifetime: "stops-on-exit", publicUrl: true, buildsFromGit: false, staticEgress: false },
    });
    expect(host.host?.inputs.secrets).toBeUndefined();
    expect(() => host({ ...declared, secrets: {} } as never)).toThrow(/no field secrets/);
  });
});

describe("cloud.host's slug", () => {
  it("is its name, else the first label of domains.app, else its repository's name", () => {
    expect(host({ name: "acme", source: "acme/acme-ops", ref: "main" }).name).toBe("acme");
    const app = { app: "acme-co.sanoma.work" };
    expect(host({ source: "acme/acme-ops", ref: "main", domains: app }).name).toBe("acme-co");
    expect(host({ source: "https://github.com/Acme/Acme_Ops.git", ref: "main" }).name).toBe("acme-ops");
  });
});
