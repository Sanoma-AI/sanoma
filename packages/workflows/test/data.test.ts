import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collection, collectionsDriver } from "../src/collection.ts";
import { DATA_TABLE, lazyPool } from "../src/db.ts";
import { allow, definePolicy, type LedgerRecord, memorySecrets, type Op, type PolicyCall } from "../src/index.ts";
import { check, drive, loadScenarios } from "../src/scenario.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import outboundNext from "./fixtures/outbound/workflows/outbound-next.ts";
import { useApp } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The collections' records in `sanoma_data`: the table, the driver,
// a workflow reading and saving a record in a live run, and the fixture's scenarios in sandbox runs.

const lead = { company: "Acme", contact: "ada@acme.test", stage: "researched", owner: "leon" };
const regclass = async (url: string) => {
  const pool = new Pool({ connectionString: url });
  try {
    return (await pool.query(`SELECT to_regclass('${DATA_TABLE}')::text AS t`)).rows[0].t as string | null;
  } finally {
    await pool.end();
  }
};

describe("sanoma_data", () => {
  it("is made by prepareDatabase, and two processes preparing a new database at once both succeed", async () => {
    const url = testDatabaseUrl("data_race");
    const server = new URL(url);
    server.pathname = "/postgres";
    const admin = new Pool({ connectionString: server.toString() });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${new URL(url).pathname.slice(1)}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    // Two instances of the module, each with its own record of what it prepared, as two processes have.
    vi.resetModules();
    const one = await import("../src/db.ts");
    vi.resetModules();
    const two = await import("../src/db.ts");
    await Promise.all([one.prepareDatabase(url), two.prepareDatabase(url)]);
    expect(await regclass(url)).toBe(DATA_TABLE);
  });
});

describe("the collections' driver on Postgres", () => {
  const leads = collection({
    name: "leads",
    key: "company",
    fields: {
      company: "text",
      stage: { enum: ["new", "won"] },
      seats: { type: "number", optional: true },
      since: { type: "date", optional: true },
    },
  });
  const accounts = collection({ name: "accounts", key: "id", fields: { id: "text" } });
  const pool = lazyPool(testDatabaseUrl("data"), "data test");
  const driver = collectionsDriver([leads, accounts], pool);
  afterAll(() => pool.close());
  beforeEach(async () => {
    await (await pool.db()).query(`DELETE FROM ${DATA_TABLE} WHERE collection IN ('leads', 'accounts')`);
  });

  let n = 0;
  /** Calls the driver as a run does: the input parsed by the operation's schema, the output too. */
  const call = async (op: Op, input: unknown, by?: string) => {
    const fn = driver.ops[`${op.resource}.${op.name}`]!;
    const context = { idempotencyKey: `t:${n++}`, runId: "t", opId: op.id, attempt: 1, secrets: memorySecrets() };
    return op.output.parse(await fn(op.input.parse(input), by === undefined ? context : { ...context, by }));
  };
  const keys = async (query: unknown) => ((await call(leads.list, query)) as { key: string }[]).map((s) => s.key);

  it("saves a record by its key, replacing the one there, and says when and by whom", async () => {
    expect(await call(leads.get, { key: "Acme" })).toBeNull();
    const first = await call(leads.save, { record: { company: "Acme", stage: "new" } });
    expect(first).toEqual({
      key: "Acme",
      record: { company: "Acme", stage: "new" },
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      updatedBy: "run:t",
    });
    const second = await call(leads.save, { record: { company: "Acme", stage: "won", seats: 4 } }, "leon");
    expect(second).toMatchObject({
      key: "Acme",
      record: { company: "Acme", stage: "won", seats: 4 },
      updatedBy: "leon",
    });
    expect(await call(leads.get, { key: "Acme" })).toEqual(second);
    expect(await call(accounts.get, { key: "Acme" })).toBeNull();
  });

  it("lists by equality and range, sorted up or down by a field (missing last) or by key, at most the limit", async () => {
    const rows = [
      { company: "Acme", stage: "won", seats: 12, since: "2026-01-15" },
      { company: "Globex", stage: "new", seats: 3, since: "2026-06-01" },
      { company: "Initech", stage: "new", seats: 8 },
      { company: "Umbrella", stage: "new" },
    ];
    for (const record of rows) await call(leads.save, { record });
    await call(accounts.save, { record: { id: "Acme" } });
    expect(await keys({})).toEqual(["Acme", "Globex", "Initech", "Umbrella"]);
    expect(await keys({ where: { stage: "new" } })).toEqual(["Globex", "Initech", "Umbrella"]);
    expect(await keys({ where: { stage: "new", seats: 8 } })).toEqual(["Initech"]);
    expect(await keys({ where: { seats: { gt: 3 } } })).toEqual(["Acme", "Initech"]);
    expect(await keys({ where: { seats: { gte: 3, lt: 12 } } })).toEqual(["Globex", "Initech"]);
    expect(await keys({ where: { since: { lte: "2026-03-01" } } })).toEqual(["Acme"]);
    expect(await keys({ order: "seats" })).toEqual(["Globex", "Initech", "Acme", "Umbrella"]);
    expect(await keys({ order: "-seats" })).toEqual(["Acme", "Initech", "Globex", "Umbrella"]);
    expect(await keys({ order: "-since", limit: 1 })).toEqual(["Globex"]);
    expect(await keys({ order: "stage", where: { seats: { lt: 100 } } })).toEqual(["Globex", "Initech", "Acme"]);
  });

  it("orders text by its bytes whatever the database's collation, and a value of another type as missing", async () => {
    for (const company of ["apple", "Banana"]) await call(leads.save, { record: { company, stage: "new", seats: 2 } });
    await (
      await pool.db()
    ).query(`INSERT INTO ${DATA_TABLE} (collection, key, record, updated_by) VALUES ('leads', 'Acme', $1, 'leon')`, [
      JSON.stringify({ company: "Acme", stage: "new", seats: "many" }),
    ]);
    expect(await keys({})).toEqual(["Acme", "Banana", "apple"]);
    expect(await keys({ where: { company: { gte: "B" } } })).toEqual(["Banana", "apple"]);
    expect(await keys({ where: { company: { gte: "a" } } })).toEqual(["apple"]);
    expect(await keys({ where: { seats: { gte: 0 } } })).toEqual(["Banana", "apple"]);
    expect(await keys({ order: "-seats" })).toEqual(["Banana", "apple", "Acme"]);
  });

  it("deletes a record by its key, saying whether there was one", async () => {
    await call(leads.save, { record: { company: "Acme", stage: "new" } });
    expect(await call(leads.delete, { key: "Acme" })).toEqual({ deleted: true });
    expect(await call(leads.delete, { key: "Acme" })).toEqual({ deleted: false });
    expect(await call(leads.get, { key: "Acme" })).toBeNull();
  });

  it("gives back a record saved under an older declaration as it is stored, with its issues", async () => {
    await (
      await pool.db()
    ).query(`INSERT INTO ${DATA_TABLE} (collection, key, record, updated_by) VALUES ('leads', 'Acme', $1, 'leon')`, [
      JSON.stringify({ company: "Acme", stage: "lost", owner: "leon" }),
    ]);
    const issues = [
      { path: ["stage"], message: expect.any(String) },
      { path: [], message: expect.stringContaining("owner") },
    ];
    expect(await call(leads.get, { key: "Acme" })).toMatchObject({
      record: { company: "Acme", stage: "lost", owner: "leon" },
      updatedBy: "leon",
      issues,
    });
    expect(await call(leads.list, {})).toMatchObject([{ key: "Acme", issues }]);
  });
});

describe("a workflow reading and saving a record", () => {
  const seen: PolicyCall[] = [];
  const app = useApp("data_run", () => ({
    workflows: [outboundNext],
    collections: [outbound],
    // Records each call it decides, for its target.
    policy: definePolicy((call) => {
      seen.push(call);
      return allow();
    }),
    root: fileURLToPath(new URL("./fixtures/outbound/", import.meta.url)),
  }));
  const db = () => new Pool({ connectionString: app.config.databaseUrl!, max: 1 });

  it("calls get and save as nodes under the policy, and the record says the run saved it", async () => {
    const pool = db();
    try {
      await pool.query(`DELETE FROM ${DATA_TABLE} WHERE collection = 'outbound'`);
      await pool.query(
        `INSERT INTO ${DATA_TABLE} (collection, key, record, updated_by) VALUES ('outbound', 'Acme', $1, 'leon')`,
        [JSON.stringify(lead)],
      );
      const runId = await app.client.start("outbound-next", { company: "Acme" }, { startedBy: { id: "leon" } });
      expect(await app.client.result(runId)).toBe(`run:${runId}`);
      const calls = (await app.client.ledger(runId)).filter(
        (r): r is Extract<LedgerRecord, { type: "op.called" }> => r.type === "op.called",
      );
      expect(calls.map(({ op, effect, node, input }) => ({ op, effect, node, input }))).toEqual([
        { op: "data.outbound.get", effect: "read", node: "0", input: { key: "Acme" } },
        {
          op: "data.outbound.save",
          effect: "write",
          node: "1.0.0",
          input: { record: { ...lead, stage: "contacted" } },
        },
      ]);
      expect(calls[1]!.output).toMatchObject({ key: "Acme", updatedBy: `run:${runId}` });
      expect(
        seen.filter((c) => c.run.id === runId).map(({ op, effect, target, before }) => [op.id, effect, target, before]),
      ).toEqual([
        ["data.outbound.get", "read", "data:outbound/Acme", undefined],
        // A save sees the record it replaces.
        ["data.outbound.save", "write", "data:outbound/Acme", lead],
      ]);
      const { rows } = await pool.query(`SELECT record, updated_by FROM ${DATA_TABLE} WHERE collection = 'outbound'`);
      expect(rows).toEqual([{ record: { ...lead, stage: "contacted" }, updated_by: `run:${runId}` }]);
    } finally {
      await pool.end();
    }
  });

  it("runs the fixture's scenarios as sandbox runs on the fake, seeded, leaving the table alone", async () => {
    const { resolveConfig } = await import("../src/index.ts");
    const scope = resolveConfig(app.config);
    const { scenarios, errors } = await loadScenarios(scope);
    expect(errors).toEqual([]);
    expect(scenarios.map((s) => s.name)).toEqual([
      "A researched lead is contacted",
      "A company with no lead is left alone",
    ]);
    const ledgers: LedgerRecord[][] = [];
    const runIds: string[] = [];
    for (const scenario of scenarios) {
      const runId = await app.client.start(scenario.workflow, scenario.input, {
        startedBy: { id: "leon" },
        sandbox: scenario.name,
      });
      runIds.push(runId);
      await drive(app.client, runId, scenario);
      const records = await app.client.ledger(runId);
      ledgers.push(records);
      expect(await check(scope, scenario, records), scenario.name).toEqual(
        scenario.expect.map((e) => ({ step: e.step, ok: true })),
      );
    }
    // Seeded through the fake's save, the key from the step, the rest made up.
    expect(ledgers[0]!.find((r) => r.type === "scenario.seeded")).toMatchObject({
      seeds: [{ op: "data.outbound.save", input: { record: { company: "Acme", stage: "researched", owner: "leon" } } }],
    });
    expect(ledgers[1]!.find((r) => r.type === "scenario.seeded")).toMatchObject({
      seeds: [{ op: "data.outbound.delete", input: { key: "Acme" }, output: { deleted: false } }],
    });
    const pool = db();
    try {
      const saved = `SELECT key FROM ${DATA_TABLE} WHERE updated_by = ANY($1)`;
      expect((await pool.query(saved, [runIds.map((id) => `run:${id}`)])).rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
