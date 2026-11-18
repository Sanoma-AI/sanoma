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

/** The id the fake gives the token's company. */
const COMPANY = "fake-company-1";

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
  // Its database the company's, bound by the company's id, as `store` resolves to in a data file.
  const declared = { hostname: "company.sanoma.work", database: COMPANY, source: repo.url, ref: "main" };
  const config: SanomaConfig = {
    workflows: [...hostCheckWorkflows],
    connectors: [hostCheck],
    root,
    ledger: memoryLedger(),
    databaseUrl,
  };
  const fake = fakeCloud({
    // The token's company, as the wizard's token is for one from the start.
    slug: "company",
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
    // The company's database, which its host runs on.
    await fake.driver.ops["database.create"]!({ desired: {} }, call("cloud.database.create"));
    mkdirSync(join(root, "resources"));
    const { database: _, ...fields } = declared;
    writeFileSync(
      join(root, "resources", "hosts.ts"),
      `import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";\n\n` +
        `export const store = cloud.database({});\n` +
        `export const host = cloud.host({ ...${JSON.stringify(fields)}, database: store });\n\nexport default [store, host];\n`,
    );
    writeLockfile(root, {
      "resources/hosts.ts#store": { type: "cloud.database", id: COMPANY },
      "resources/hosts.ts#host": { type: "cloud.host", id: COMPANY },
    });
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
    const plan = (await op("plan")({ id: COMPANY, desired })) as { action: string };
    if (plan.action === "none")
      return ((await op("read")({ id: COMPANY })) as { state: Record<string, unknown> }).state;
    const done = await op(plan.action === "create" ? "create" : "update")({ id: COMPANY, desired });
    return (done as { state: Record<string, unknown> }).state;
  }

  it("passes every check, the ones of a host that stops among them", { timeout: 300_000 }, async () => {
    const results = await checkHost({
      type: host,
      apply,
      stop: async () => void (await op("delete")({ id: COMPANY })),
      suspend: () => fake.stop(),
      running: async () => fake.running(),
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
      { name: "two deploys at once leave one revision, the loser at once", ok: true },
      { name: "a new commit shows as drift that apply clears", ok: true },
      { name: "no secret is in the ledger", ok: true },
    ]);
    // The company kept its id and its address across a close and a sign-up, and its host runs the last commit.
    expect(fake.state.company).toMatchObject({ id: COMPANY, slug: "company" });
    expect(fake.state.company!.host?.revision).toBe(await resolveRevision(repo.url, "main"));
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

/** A host of the token's company at `acme`, as `cloud.host`'s address tests declare it. */
const desired = {
  hostname: "acme.sanoma.work",
  database: COMPANY,
  source: "https://github.com/acme/acme-ops.git",
  revision: "r1",
};

/** The fake's ops for the token's company at `acme`, its database made. */
async function acme() {
  const fake = fakeCloud({ slug: "acme", taken: ["taken"] });
  const op = (name: string, input: object) => fake.driver.ops[name]!(input, call(`cloud.${name}`));
  await op("database.create", { desired: {} });
  return { fake, op };
}

describe("cloud.host's address", () => {
  it("moves with its hostname, in place: the same company and host, at another address", async () => {
    const { fake, op: ops } = await acme();
    const op = (name: string, input: object) => ops(`host.${name}`, input);
    try {
      expect(await op("create", { desired })).toMatchObject({ id: COMPANY, state: { hostname: "acme.sanoma.work" } });
      const renamed = { ...desired, hostname: "acme-co.sanoma.work" };
      expect(await op("plan", { id: COMPANY, desired: renamed })).toMatchObject({
        action: "update",
        replace: [],
        planned: { id: COMPANY, hostname: "acme-co.sanoma.work" },
      });
      expect(await op("update", { id: COMPANY, desired: renamed })).toMatchObject({
        id: COMPANY,
        state: { id: COMPANY, hostname: "acme-co.sanoma.work", revision: "r1" },
      });
      expect(fake.state.company).toMatchObject({ id: COMPANY, slug: "acme-co", host: { revision: "r1" } });
      // Someone else's address is refused, and the company stays where it was.
      await expect(
        op("update", { id: COMPANY, desired: { ...desired, hostname: "taken.sanoma.work" } }),
      ).rejects.toThrow("taken.sanoma.work is taken");
      expect(fake.state.company?.slug).toBe("acme-co");
      // The old address stays the company's: not free for anyone else, and a rename back takes it.
      expect(await ops("company.available", { slug: "acme" })).toEqual({ available: false, yours: true });
      // A slug the Cloud does not give is refused as the declaration is read, before any call.
      for (const hostname of ["ab.sanoma.work", "www.sanoma.work", "a--b.sanoma.work"]) {
        await expect(op("plan", { id: COMPANY, desired: { ...desired, hostname } }), hostname).rejects.toThrow(
          /sanoma\.work/,
        );
      }
      expect(await op("update", { id: COMPANY, desired })).toMatchObject({ state: { hostname: "acme.sanoma.work" } });
    } finally {
      await fake.close();
    }
  });

  it("closes as the Cloud does: the database only after the host, and the company with its last part", async () => {
    const { fake, op } = await acme();
    try {
      await op("host.create", { desired });
      await expect(op("database.delete", { id: COMPANY })).rejects.toThrow("Close the company's host before");
      await op("host.delete", { id: COMPANY });
      await op("database.delete", { id: COMPANY });
      // Closed: its token revoked, its address kept from everyone.
      expect(fake.state).toMatchObject({ revoked: true, addresses: { acme: COMPANY } });
      expect(fake.state.company).toBeUndefined();
      await expect(op("host.read", { id: COMPANY })).rejects.toMatchObject({ status: 401 });
    } finally {
      await fake.close();
    }
  });

  it("refuses a host for a company with no database, as the Cloud does", async () => {
    const fake = fakeCloud({ slug: "acme" });
    try {
      await expect(fake.driver.ops["host.create"]!({ desired }, call("cloud.host.create"))).rejects.toThrow(
        "The host needs the company's database",
      );
    } finally {
      await fake.close();
    }
  });
});
