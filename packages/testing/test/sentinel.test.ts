import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fakeDatabase } from "../src/database.ts";
import { findSentinels, testDatabaseUrl } from "../src/index.ts";

// Needs Postgres. `findSentinels` over a database of its own: every text column of every schema
// read, Postgres's own and bytes left out.

const database = fakeDatabase("sentinel");
const url = testDatabaseUrl("sentinel");

beforeAll(async () => {
  await database.remove();
  await database.apply();
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(
      `CREATE SCHEMA store;
       CREATE TABLE public.runs (id int, input text, output jsonb, note varchar(200), sealed bytea, doc xml);
       CREATE TABLE store."Kept Values" ("the value" text[], other int);
       INSERT INTO public.runs VALUES
         (1, 'token planted-sentinel-0001 sent', '{"nested": {"key": "planted-sentinel-0002"}}', 'clean', 'planted-sentinel-0003', '<a>planted-sentinel-0005</a>');
       INSERT INTO store."Kept Values" VALUES (ARRAY['a', 'planted-sentinel-0004'], 1);`,
    );
  } finally {
    await db.end();
  }
});
afterAll(() => database.remove());

it("names the schema, table and column of each sentinel a text column holds, bytes left out", async () => {
  const planted = [1, 2, 3, 4, 5].map((n) => `planted-sentinel-000${n}`);
  expect(await findSentinels(url, [...planted, "never-planted-0006"])).toEqual([
    { schema: "public", table: "runs", column: "doc", sentinel: "planted-sentinel-0005" },
    { schema: "public", table: "runs", column: "input", sentinel: "planted-sentinel-0001" },
    { schema: "public", table: "runs", column: "output", sentinel: "planted-sentinel-0002" },
    { schema: "store", table: "Kept Values", column: "the value", sentinel: "planted-sentinel-0004" },
  ]);
  expect(await findSentinels(url, ["never-planted-0006"])).toEqual([]);
});

it("refuses a sentinel JSON would write otherwise, or one short enough to match by chance", async () => {
  await expect(findSentinels(url, ['quote"inside-sentinel'])).rejects.toThrow("Not a sentinel");
  await expect(findSentinels(url, ["short"])).rejects.toThrow("Not a sentinel");
});
