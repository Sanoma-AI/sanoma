import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { checkDatabase, databaseCheckConfig, fakeDatabase } from "@sanoma-ai/testing/database";
import { type CallContext, memorySecrets, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { describeConfig } from "@sanoma-ai/workflows/describe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/connector.ts";
import { fakeCloud } from "../src/fake.ts";
import { cloud } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. The Database contract's conformance kit against the fake Cloud,
// a database of the test Postgres standing in for the company's Neon project (`fakeDatabase`):
// apply makes the database on the fake, and a suspend drops every connection to the stand-in, as
// a Neon compute's does.

let n = 0;
const call = (opId: string): CallContext => ({
  idempotencyKey: `${opId}:${++n}`,
  runId: "conformance",
  opId,
  attempt: 1,
  secrets: memorySecrets(),
});

describe("cloud.database meets the Database contract", () => {
  const db = fakeDatabase("sanoma_cloud_kit");
  const fake = fakeCloud();
  const op = (name: string, input: object) =>
    fake.driver.ops[`database.${name}`]!(input, call(`cloud.database.${name}`));
  let client: SanomaClient;

  beforeAll(async () => {
    // A database of its own for each run: one an earlier run left would hold its runs.
    await db.remove();
    await db.apply();
    client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
  });

  afterAll(async () => {
    await client?.close();
    await fake.close();
    await db.remove();
  });

  it("passes every check against the fake, with the test Postgres as its database", { timeout: 120_000 }, async () => {
    const desired = { name: "acme", region: "eu-central" };
    const apply = async () => {
      const plan = (await op("plan", { id: "acme", desired })) as { action: string };
      if (plan.action === "create")
        return ((await op("create", { desired })) as { state: Record<string, unknown> }).state;
      return ((await op("read", { id: "acme" })) as { state: Record<string, unknown> }).state;
    };
    const results = await checkDatabase({
      type: database,
      apply,
      url: db.url,
      suspend: db.suspend,
      client,
      timeoutMs: 30_000,
    });
    expect(results).toEqual([
      { name: "DBOS's tables migrate and a worker starts on the url", ok: true },
      { name: "the next store read sees a credential change", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "a queued run drains after a suspend and a wake", ok: true },
    ]);
    expect(fake.state.companies.acme?.database).toEqual({ id: "fake-db-1", region: "eu-central" });
  });

  it("is a database type in a config, whose storeUrl stores nothing: the host binds the URL", async () => {
    expect(() => resolveConfig({ workflows: [], connectors: [cloud] })).not.toThrow();
    expect(database.database).toMatchObject({
      capabilities: { pauses: true, branch: false },
      storeUrl: "cloud.database.storeUrl",
      regions: ["us-east", "us-west", "eu-central", "eu-west", "ap-southeast"],
    });
    const secrets = memorySecrets();
    const stored = await fake.driver.ops["database.storeUrl"]!(
      { id: "acme", export: "store" },
      { ...call("cloud.database.storeUrl"), secrets },
    );
    expect(stored).toMatchObject({ stored: false });
    expect(await secrets.get("SANOMA_DATABASE_URL_STORE")).toBeUndefined();
  });

  it("refuses a region the Cloud has not, as the declaration is read", () => {
    expect(() => database({ region: "mars-1" as never })).toThrow(/region/);
  });
});

describe("Sanoma Cloud in a data file", () => {
  it("declares the database and the host the wizard writes, which the config reads with no problem", () => {
    const root = mkdtempSync(join(tmpdir(), "sanoma-cloud-declared-"));
    mkdirSync(join(root, "resources", "sanoma"), { recursive: true });
    writeFileSync(
      join(root, "resources", "sanoma", "infra.ts"),
      [
        'import { cloud } from "@sanoma-ai/connector-sanoma-cloud/resources";',
        "",
        'export const store = cloud.database({ region: "us-east" });',
        "export const host = cloud.host({",
        '  source: "https://github.com/acme/acme-ops.git",',
        '  ref: "main",',
        '  domains: { app: "acme.sanoma.work" },',
        "});",
        "export default [store, host];",
        "",
      ].join("\n"),
    );
    try {
      const config = {
        workflows: [],
        connectors: [cloud],
        root,
        databaseUrl: testDatabaseUrl("sanoma_cloud_declared"),
      };
      const { problems, resources } = describeConfig(config);
      expect(problems).toEqual([]);
      expect(resources.map((r) => [r.id, r.vendor, r.type, r.name])).toEqual([
        ["resources/sanoma/infra.ts#store", "cloud", "database", "store"],
        ["resources/sanoma/infra.ts#host", "cloud", "host", "acme"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
