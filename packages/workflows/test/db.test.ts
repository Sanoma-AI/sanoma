import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl } from "@sanoma/testing";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createTable, lazyPool, pgCode, prepareDatabase } from "../src/db.ts";

const databaseUrl = testDatabaseUrl("db");
const pool = new Pool({ connectionString: databaseUrl });
afterAll(() => pool.end());

describe("pgCode", () => {
  it("is the error's Postgres code, or empty", () => {
    expect(pgCode(Object.assign(new Error("dup"), { code: "23505" }))).toBe("23505");
    expect(pgCode(new Error("plain"))).toBe("");
    expect(pgCode(undefined)).toBe("");
  });
});

describe("createTable", () => {
  it("lets two processes make one table at once, and names the table on any other failure", async () => {
    await prepareDatabase(databaseUrl);
    await pool.query("DROP TABLE IF EXISTS sanoma_db_test");
    const ddl = "CREATE TABLE IF NOT EXISTS sanoma_db_test (n int PRIMARY KEY)";
    // Each on a connection of its own, as two processes would be.
    await Promise.all([createTable(pool, ddl, "test"), createTable(pool, ddl, "test")]);
    expect((await pool.query("SELECT to_regclass('sanoma_db_test')::text AS t")).rows).toEqual([
      { t: "sanoma_db_test" },
    ]);
    await expect(createTable(pool, "CREATE TABLE sanoma_db_test (n int) NOPE", "test")).rejects.toThrow(
      /^could not prepare the test table: /,
    );
    await pool.query("DROP TABLE sanoma_db_test");
  });
});

describe("lazyPool", () => {
  it("prepares the database once per process, tries again after a failure, and is final once closed", async () => {
    const url = testDatabaseUrl("db_lazy");
    const migrate = vi.spyOn(DBOS, "migrate");
    migrate.mockRejectedValueOnce(new Error("Postgres is down"));
    const first = lazyPool(url, "first");
    const second = lazyPool(url, "second");
    try {
      await expect(first.db()).rejects.toThrow("could not prepare the database: Postgres is down");
      // Forgotten, so the next use prepares again, once for both pools.
      const [a, b] = await Promise.all([first.db(), second.db()]);
      expect(a).not.toBe(b);
      expect(await second.db()).toBe(b);
      expect(migrate).toHaveBeenCalledTimes(2);
      expect((await a.query("SELECT to_regclass('sanoma_ledger')::text AS t")).rows).toEqual([{ t: "sanoma_ledger" }]);
    } finally {
      await first.close();
      await second.close();
    }
    await expect(first.db()).rejects.toThrow("the first store is closed");
    await first.close();
  });
});
