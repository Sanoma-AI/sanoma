import { testDatabaseUrl } from "sanoma/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPreparedOnly, prepareDatabase } from "../src/db.ts";
import { cedarWasm, type CedarWasm, useCedarWasm } from "../src/schema.ts";

// What the Cloudflare host's Worker sets for its whole process (so in a file of its own): a
// database it only checks, never prepares, and Cedar's build for the web.
const databaseUrl = testDatabaseUrl("worker_runtime");
const name = new URL(databaseUrl).pathname.slice(1);
const admin = () => {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return new Client({ connectionString: url.toString() });
};

beforeAll(async () => {
  const db = admin();
  await db.connect();
  try {
    await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await db.query(`CREATE DATABASE "${name}"`);
  } finally {
    await db.end();
  }
});

afterAll(async () => {
  const db = admin();
  await db.connect();
  await db.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).finally(() => db.end());
});

describe("checkPreparedOnly", () => {
  it("refuses a database with no tables, naming what makes them, and makes none", async () => {
    checkPreparedOnly("the container");
    await expect(prepareDatabase(databaseUrl)).rejects.toThrow(
      "the database has no DBOS's and Sanoma's tables yet: the container makes them, and this process never does",
    );
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    try {
      const { rows } = await db.query("SELECT to_regclass('dbos.workflow_status') AS made");
      expect(rows).toEqual([{ made: null }]);
    } finally {
      await db.end();
    }
  });
});

describe("useCedarWasm", () => {
  it("is the Cedar the runtime calls from then on, loaded on its first use", () => {
    const web = { validate: () => ({ type: "success" }) } as unknown as CedarWasm;
    let loads = 0;
    useCedarWasm(() => (loads++, web));
    expect(loads).toBe(0);
    expect(cedarWasm()).toBe(web);
    expect(cedarWasm()).toBe(web);
    expect(loads).toBe(1);
  });
});
