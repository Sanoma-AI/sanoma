import { memorySecrets, resolveConfig, SanomaClient } from "@sanoma-ai/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabase, databaseCheckConfig, fakeDatabase } from "../src/database.ts";
import { testDatabaseUrl } from "../src/index.ts";

// Needs Postgres: `pnpm db:up`. The conformance kit against a database of the test Postgres that
// pauses: its suspend drops every connection to it, the worker's and the client's, so the
// fourth check is the reconnect a Neon compute's suspend asks for.

describe("the database conformance kit", () => {
  const db = fakeDatabase("database_kit");
  let client: SanomaClient;

  beforeAll(async () => {
    // A database of its own for each run: one an earlier run left would hold its runs.
    await db.remove();
    await db.apply();
    client = await SanomaClient.connect(databaseCheckConfig(await db.url()));
  });

  afterAll(async () => {
    await client?.close();
    await db.remove();
  });

  it("passes every check against a database that pauses", async () => {
    const dropped: number[] = [];
    const suspend = async () => void dropped.push(await db.suspend());
    const results = await checkDatabase({ ...db, suspend, client, timeoutMs: 30_000 });
    expect(results).toEqual([
      { name: "DBOS's tables migrate and a worker starts on the url", ok: true },
      { name: "LISTEN hears a credential change", ok: true },
      { name: "a queued run drains", ok: true },
      { name: "a queued run drains after a suspend and a wake", ok: true },
    ]);
    // The worker's connections and the client's, LISTEN's among them.
    expect(dropped[0]).toBeGreaterThan(2);
  });

  it("fails the rest at once when the database is not healthy, so no worker starts", async () => {
    const results = await checkDatabase({ ...db, apply: async () => ({}), client, timeoutMs: 1_000 });
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["DBOS's tables migrate and a worker starts on the url", false],
      ["LISTEN hears a credential change", false],
      ["a queued run drains", false],
      ["a queued run drains after a suspend and a wake", false],
    ]);
    expect(results[0]!.error).toBe("its state says it is not healthy");
    expect(results[1]!.error).toBe("no worker started");
  });
});

describe("fakeDatabase", () => {
  const db = fakeDatabase("database_fake");

  afterAll(() => db.remove());

  it("meets the contract in a config: it pauses, and stores its URL as SANOMA_DATABASE_URL_<EXPORT>", async () => {
    expect(() => resolveConfig({ workflows: [], connectors: [db.connector] })).not.toThrow();
    expect(db.type.database).toMatchObject({ capabilities: { pauses: true, branch: false }, regions: ["local"] });
    const secrets = memorySecrets({});
    const call = { idempotencyKey: "k", runId: "r", opId: "testdb.database.storeUrl", attempt: 1, secrets };
    expect(await db.driver.ops["database.storeUrl"]!({ id: "database_fake", export: "store" }, call)).toEqual({
      secret: "SANOMA_DATABASE_URL_STORE",
    });
    expect(await secrets.get("SANOMA_DATABASE_URL_STORE")).toBe(testDatabaseUrl("database_fake"));
  });

  it("makes its database on apply, reads it, and is gone once removed", async () => {
    const read = (id: string) => db.driver.ops["database.read"]!({ id }, {} as never);
    expect(db.type.database!.outputs(await db.apply())).toEqual({ healthy: true });
    expect(await read("database_fake")).toMatchObject({ gone: false, state: { name: "database_fake" } });
    await db.remove();
    expect(await read("database_fake")).toEqual({ id: "database_fake", gone: true });
  });
});
