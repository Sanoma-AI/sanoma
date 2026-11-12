import { fileURLToPath } from "node:url";
import { testDatabaseUrl } from "sanoma/testing";
import { eq, getTableName, inArray } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { collection, recordsOps } from "../src/collection.ts";
import { collectionsDriver, recordsDriver } from "../src/collection-driver.ts";
import { reshape } from "../src/shared.ts";
import { databaseOn, lazyDb } from "../src/db.ts";
import { data } from "../src/db/company.ts";
import { z } from "zod";
import { defineWorkflow, type LedgerRecord, memorySecrets, type Op } from "../src/index.ts";
import { check, drive, loadScenarios } from "../src/scenario.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import outboundNext from "./fixtures/outbound/workflows/outbound-next.ts";
import { rootWith, useApp } from "./harness.ts";

// Needs Postgres: `pnpm db:up`. The collections' records in `sanoma_data`: the table, the driver,
// a workflow reading and saving a record in a live run, and the fixture's scenarios in sandbox runs.

const lead = { company: "Acme", contact: "ada@acme.test", stage: "researched", owner: "leon" };
const regclass = async (url: string) => {
  const pool = new Pool({ connectionString: url });
  try {
    return (await pool.query(`SELECT to_regclass('${getTableName(data)}')::text AS t`)).rows[0].t as string | null;
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
    expect(await regclass(url)).toBe(getTableName(data));
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
  const url = testDatabaseUrl("data");
  const pool = lazyDb(url, "data test");
  const driver = collectionsDriver([leads, accounts], pool);
  afterAll(() => pool.close());
  beforeEach(async () => {
    await (await pool.db()).delete(data).where(inArray(data.collection, ["leads", "accounts"]));
  });

  let n = 0;
  /** Calls the driver as a run does: the input parsed by the operation's schema, the output too. */
  const call = async (op: Op, input: unknown, by?: string, attempt = 1) => {
    const fn = driver.ops[`${op.resource}.${op.name}`]!;
    const context = { idempotencyKey: `t:${n++}`, runId: "t", opId: op.id, attempt, secrets: memorySecrets() };
    return op.output.parse(await fn(op.input.parse(input), by === undefined ? context : { ...context, by }));
  };
  const keys = async (query: unknown) => ((await call(leads.list, query)) as { key: string }[]).map((s) => s.key);

  it("claims an absent key atomically across competing callers", async () => {
    const results = await Promise.allSettled([
      call(leads.save, { record: { company: "Acme", stage: "new", seats: 1 }, ifAbsent: true }, "ada"),
      call(leads.save, { record: { company: "Acme", stage: "new", seats: 2 }, ifAbsent: true }, "bo"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected");
    const winner = results.find((r) => r.status === "fulfilled");
    expect(failed).toMatchObject({
      status: "rejected",
      reason: {
        retryable: false,
        vendorCode: "record_exists",
        status: 409,
        current: winner?.status === "fulfilled" ? winner.value : undefined,
      },
    });
    expect(await call(leads.get, { key: "Acme" })).toEqual(winner?.status === "fulfilled" ? winner.value : undefined);
  });

  it("recovers an identical insert-only save without replacing later progress or another actor's record", async () => {
    const record = { company: "Acme", stage: "new", seats: 1 };
    const first = await call(leads.save, { record, ifAbsent: true }, "ada");
    // A response can be lost after commit: the next call must recover the original receipt.
    expect(
      await call(leads.save, { record: { seats: 1, stage: "new", company: "Acme" }, ifAbsent: true }, "ada"),
    ).toEqual(first);
    await expect(call(leads.save, { record, ifAbsent: true }, "bo")).rejects.toMatchObject({
      vendorCode: "record_exists",
    });
    const advanced = await call(leads.save, { record: { ...record, stage: "won" } }, "ada");
    await expect(call(leads.save, { record, ifAbsent: true }, "ada")).rejects.toMatchObject({
      vendorCode: "record_exists",
    });
    expect(await call(leads.get, { key: "Acme" })).toEqual(advanced);
  });

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

  it("allows only one competing conditional transition and refuses stale or missing state", async () => {
    const record = { company: "Acme", stage: "new" };
    await call(leads.save, { record });
    const results = await Promise.allSettled([
      call(leads.save, { record: { ...record, seats: 1 }, ifRecord: record }, "ada"),
      call(leads.save, { record: { ...record, seats: 2 }, ifRecord: record }, "bo"),
    ]);
    const won = results.find((result) => result.status === "fulfilled");
    expect(won).toBeDefined();
    // The refusal carries the record as the winner left it, so the loser settles the conflict without another read.
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409, retryable: false, vendorCode: "record_changed", current: won!.value },
    });
    const current = await call(leads.get, { key: "Acme" });
    await expect(call(leads.save, { record, ifRecord: record }, "late")).rejects.toMatchObject({
      vendorCode: "record_changed",
      current,
    });
    expect(await call(leads.get, { key: "Acme" })).toEqual(current);
    await expect(
      call(leads.save, { record: { company: "Missing", stage: "new" }, ifRecord: {} }),
    ).rejects.toMatchObject({ vendorCode: "record_changed", current: null });
    expect(await call(leads.get, { key: "Missing" })).toBeNull();
  });

  it("recovers a conditional write whose committed response was lost, but never rolls back later progress", async () => {
    const before = { company: "Acme", stage: "new" };
    const record = { ...before, seats: 1 };
    await call(leads.save, { record: before }, "owner");
    const raw = new Pool({ connectionString: url, max: 1 });
    const query = raw.query.bind(raw) as (...a: unknown[]) => Promise<unknown>;
    let loseResponse = true;
    // The statement commits, then its response is lost.
    raw.query = (async (...args: unknown[]) => {
      const result = await query(...args);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Response lost after commit");
      }
      return result;
    }) as Pool["query"];
    onTestFinished(() => raw.end());
    const uncertain = collectionsDriver([leads], { db: async () => databaseOn(raw) });
    const context = {
      idempotencyKey: "lost-transition",
      runId: "transition",
      by: "run:transition",
      opId: leads.save.id,
      attempt: 1,
      secrets: memorySecrets(),
    };
    const write = () => uncertain.ops["leads.save"]!({ record, ifRecord: before }, context);
    await expect(write()).rejects.toThrow("Response lost after commit");
    const committed = await call(leads.get, { key: "Acme" });
    expect(await write()).toEqual(committed);
    await expect(call(leads.save, { record, ifRecord: before }, "another")).rejects.toMatchObject({
      vendorCode: "record_changed",
    });
    const progressed = await call(leads.save, { record: { ...record, stage: "won" }, ifRecord: record }, "owner");
    await expect(write()).rejects.toMatchObject({ vendorCode: "record_changed" });
    expect(await call(leads.get, { key: "Acme" })).toEqual(progressed);
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
    await (await pool.db()).insert(data).values({
      collection: "leads",
      key: "Acme",
      record: { company: "Acme", stage: "new", seats: "many" },
      updatedBy: "leon",
    });
    expect(await keys({})).toEqual(["Acme", "Banana", "apple"]);
    expect(await keys({ where: { company: { gte: "B" } } })).toEqual(["Banana", "apple"]);
    expect(await keys({ where: { company: { gte: "a" } } })).toEqual(["apple"]);
    expect(await keys({ where: { seats: { gte: 0 } } })).toEqual(["Banana", "apple"]);
    expect(await keys({ order: "-seats" })).toEqual(["Banana", "apple", "Acme"]);
  });

  it("deletes a record by its key, saying whether there was one", async () => {
    await call(leads.save, { record: { company: "Acme", stage: "new" } });
    expect(await call(leads.delete, { key: "Acme" })).toEqual({ key: "Acme", deleted: true });
    expect(await call(leads.delete, { key: "Acme" })).toEqual({ key: "Acme", deleted: false });
    expect(await call(leads.get, { key: "Acme" })).toBeNull();
  });

  it("saves and deletes a batch in one transaction, all or none, answering in order, and counts", async () => {
    const acme = { company: "Acme", stage: "new", seats: 1 };
    const globex = { company: "Globex", stage: "new", seats: 3 };
    const initech = { company: "Initech", stage: "won" };
    for (const record of [acme, globex, initech]) await call(leads.save, { record }, "leon");
    expect(await call(leads.count, {})).toEqual({ count: 3 });
    expect(await call(leads.count, { where: { stage: "new", seats: { gte: 3 } } })).toEqual({ count: 1 });
    expect(await call(leads.count, { where: { seats: { gt: 100 } } })).toEqual({ count: 0 });
    const results = await call(
      leads.saveMany,
      {
        records: [
          { record: { ...acme, stage: "won" }, ifRecord: acme },
          { record: { company: "Umbrella", stage: "new" } },
        ],
        deletes: [{ key: "Globex", ifRecord: globex }, { key: "Nobody" }],
      },
      "ada",
    );
    expect(results).toEqual([
      { key: "Acme", record: { ...acme, stage: "won" }, updatedAt: expect.any(String), updatedBy: "ada" },
      {
        key: "Umbrella",
        record: { company: "Umbrella", stage: "new" },
        updatedAt: expect.any(String),
        updatedBy: "ada",
      },
      { key: "Globex", deleted: true },
      { key: "Nobody", deleted: false },
    ]);
    expect(await keys({})).toEqual(["Acme", "Initech", "Umbrella"]);
    // A conflict on any entry rolls back every entry, each conflict answered with the record as it stands.
    const current = await call(leads.get, { key: "Acme" });
    await expect(
      call(
        leads.saveMany,
        {
          records: [
            { record: { company: "Wayne", stage: "new" } },
            { record: { ...acme, seats: 9 }, ifRecord: acme },
            { record: { company: "Umbrella", stage: "won" }, ifAbsent: true },
          ],
          deletes: [
            { key: "Initech", ifRecord: acme },
            { key: "Gone", ifRecord: acme },
          ],
        },
        "ada",
      ),
    ).rejects.toMatchObject({
      status: 409,
      retryable: false,
      vendorCode: "record_changed",
      conflicts: [
        { key: "Acme", current },
        { key: "Umbrella", current: await call(leads.get, { key: "Umbrella" }) },
        { key: "Initech", current: await call(leads.get, { key: "Initech" }) },
        { key: "Gone", current: null },
      ],
    });
    expect(await keys({})).toEqual(["Acme", "Initech", "Umbrella"]);
    expect(await call(leads.get, { key: "Acme" })).toEqual(current);
    await expect(call(leads.delete, { key: "Acme", ifRecord: acme })).rejects.toMatchObject({
      vendorCode: "record_changed",
      current,
    });
    // A retry finding no record deleted it the first time; one finding another record did not.
    expect(await call(leads.delete, { key: "Gone", ifRecord: acme }, undefined, 2)).toEqual({
      key: "Gone",
      deleted: true,
    });
    await expect(call(leads.delete, { key: "Acme", ifRecord: acme }, undefined, 2)).rejects.toMatchObject({ current });
    expect(await call(leads.delete, { key: "Acme", ifRecord: { ...acme, stage: "won" } })).toEqual({
      key: "Acme",
      deleted: true,
    });
    expect(await call(leads.count, {})).toEqual({ count: 2 });
  });

  it("gives back a record saved under an older declaration as it is stored, with its issues", async () => {
    await (await pool.db()).insert(data).values({
      collection: "leads",
      key: "Acme",
      record: { company: "Acme", stage: "lost", owner: "leon" },
      updatedBy: "leon",
    });
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

describe("sanoma.records.reshape on Postgres", () => {
  const url = testDatabaseUrl("data");
  const pool = lazyDb(url, "reshape test");
  const driver = recordsDriver(() => pool.db());
  const op = recordsOps.records.reshape;
  afterAll(() => pool.close());
  beforeEach(async () => {
    await (await pool.db()).delete(data).where(inArray(data.collection, ["deals", "others"]));
  });
  /** Calls the driver as a run does, as `run:t`: the input parsed by the operation's schema, the output too. */
  const reshapeCall = async (input: unknown) =>
    op.output.parse(
      await driver.ops["records.reshape"]!(op.input.parse(input), {
        idempotencyKey: "t:reshape",
        runId: "t",
        opId: op.id,
        attempt: 1,
        secrets: memorySecrets(),
      }),
    );
  const rowsOf = async (name: string) =>
    (await pool.db())
      .select({ key: data.key, record: data.record, updatedBy: data.updatedBy })
      .from(data)
      .where(eq(data.collection, name))
      .orderBy(data.key);
  const deals = [
    { company: "Acme", seats: "12", owner: "leon", stage: "won" },
    { company: "Brightwater", seats: "about 40", owner: "leon" },
    { company: "Cedar", seats: 4, lastTouched: "2026-01-02" },
    { company: "Delta", seats: "", lastTouched: "2026-01-03", contact: "x" },
    { company: "Elm" },
  ];
  const changes = [
    { kind: "rename", from: "lastTouched", to: "lastContact" },
    { kind: "retype", field: "seats", to: "number", decision: "clear" },
    { kind: "retype", field: "stage", to: { enum: ["new", "won"] } },
  ];

  it("brings each kind of change along in one call, writing only the records that changed, by the run, and counts them", async () => {
    const db = await pool.db();
    await db
      .insert(data)
      .values([
        ...deals.map((record) => ({ collection: "deals", key: record.company, record, updatedBy: "leon" })),
        { collection: "others", key: "Acme", record: { company: "Acme", seats: "12" }, updatedBy: "leon" },
      ]);
    expect(await reshapeCall({ collection: "deals", changes })).toEqual({
      rows: 5,
      changed: 4,
      converted: 1,
      cleared: 1,
      kept: 0,
    });
    expect(await rowsOf("deals")).toEqual([
      { key: "Acme", record: { company: "Acme", seats: 12, owner: "leon", stage: "won" }, updatedBy: "run:t" },
      { key: "Brightwater", record: { company: "Brightwater", owner: "leon" }, updatedBy: "run:t" },
      { key: "Cedar", record: { company: "Cedar", seats: 4, lastContact: "2026-01-02" }, updatedBy: "run:t" },
      // The empty value is no value to convert: dropped.
      { key: "Delta", record: { company: "Delta", lastContact: "2026-01-03", contact: "x" }, updatedBy: "run:t" },
      { key: "Elm", record: { company: "Elm" }, updatedBy: "leon" },
    ]);
    // Another collection's records are left alone.
    expect(await rowsOf("others")).toEqual([
      { key: "Acme", record: { company: "Acme", seats: "12" }, updatedBy: "leon" },
    ]);
    // Again: nothing left to bring along.
    expect(await reshapeCall({ collection: "deals", changes })).toEqual({
      rows: 5,
      changed: 0,
      converted: 0,
      cleared: 0,
      kept: 0,
    });
  });

  it("keeps the values that cannot convert by default, counting them each time, and agrees with `reshape` in memory", async () => {
    const db = await pool.db();
    await db
      .insert(data)
      .values(deals.map((record) => ({ collection: "deals", key: record.company, record, updatedBy: "leon" })));
    const keep = [{ kind: "retype", field: "seats", to: "number" }] as const;
    const expected = reshape(deals, keep);
    expect(await reshapeCall({ collection: "deals", changes: keep })).toEqual(expected.counts);
    expect(expected.counts).toMatchObject({ converted: 1, kept: 1, cleared: 0 });
    expect((await rowsOf("deals")).map((row) => row.record)).toEqual(
      deals.map((record, i) => expected.changed.get(i) ?? record),
    );
    expect(await reshapeCall({ collection: "deals", changes: keep })).toMatchObject({ changed: 0, kept: 1 });
  });

  it("writes a collection larger than one statement's chunk whole", async () => {
    const many = Array.from({ length: 1234 }, (_, i) => ({ company: `c${String(i).padStart(4, "0")}`, seats: `${i}` }));
    await (
      await pool.db()
    )
      .insert(data)
      .values(many.map((record) => ({ collection: "deals", key: record.company, record, updatedBy: "leon" })));
    expect(
      await reshapeCall({ collection: "deals", changes: [{ kind: "retype", field: "seats", to: "number" }] }),
    ).toMatchObject({ rows: 1234, changed: 1234, converted: 1234 });
    const rows = await rowsOf("deals");
    expect(rows.every(({ record }, i) => record.seats === i && typeof record.seats === "number")).toBe(true);
  });
});

describe("a workflow reading and saving a record", () => {
  // The outbound fixture, with a policy that refuses a save with no record before it: one that
  // passes shows the policy was given the record the save replaces.
  const root = rootWith(
    {
      "policies/policy.cedar": `@reason("a save replaces a lead")
forbid (principal, action == Sanoma::Action::"data.outbound.save", resource in Sanoma::Collection::"outbound")
unless { context has before };
`,
    },
    fileURLToPath(new URL("./fixtures/outbound/", import.meta.url)),
  );
  /** Saves a lead per company and deletes the keys named, in one batch. */
  const outboundBatch = defineWorkflow({
    name: "outbound-batch",
    title: "Save leads together",
    trigger: "manual",
    input: z.object({ companies: z.array(z.string()), deletes: z.array(z.string()).default([]) }),
    uses: [outbound.saveMany],
    run: async (ctx, { companies, deletes }) =>
      ctx.data.outbound.saveMany({
        records: companies.map((company) => ({ record: { ...lead, company, stage: "contacted" } })),
        deletes: deletes.map((key) => ({ key })),
      }),
  });
  const app = useApp("data_run", () => ({ workflows: [outboundNext, outboundBatch], collections: [outbound], root }));
  const db = () => new Pool({ connectionString: app.config.databaseUrl!, max: 1 });
  const calls = async (runId: string) =>
    (await app.client.ledger(runId)).filter(
      (r): r is Extract<LedgerRecord, { type: "op.called" }> => r.type === "op.called",
    );

  it("calls get and save as nodes under the policy, the save with the record it replaces, and the record says the run saved it", async () => {
    const pool = db();
    const store = databaseOn(pool);
    try {
      await store.delete(data).where(eq(data.collection, "outbound"));
      await store.insert(data).values({ collection: "outbound", key: "Acme", record: lead, updatedBy: "leon" });
      const runId = await app.client.start("outbound-next", { company: "Acme" }, { startedBy: { id: "leon" } });
      expect(await app.client.result(runId)).toBe(`run:${runId}`);
      const made = await calls(runId);
      expect(made.map(({ op, effect, node, target, input }) => ({ op, effect, node, target, input }))).toEqual([
        { op: "data.outbound.get", effect: "read", node: "0", target: "data:outbound/Acme", input: { key: "Acme" } },
        {
          op: "data.outbound.save",
          effect: "write",
          node: "1.0.0",
          target: "data:outbound/Acme",
          input: { record: { ...lead, stage: "contacted" }, ifRecord: lead },
        },
      ]);
      expect(made[1]!.output).toMatchObject({ key: "Acme", updatedBy: `run:${runId}` });
      // The record's history, from the app's ledger (on disk): the run's calls on it, newest first.
      expect((await app.client.history("data:outbound/Acme")).map((r) => r.id)).toEqual([made[1]!.id, made[0]!.id]);
      // A save sees the record it replaces: the policy let it through.
      expect(made.map(({ decision }) => decision.kind)).toEqual(["allow", "allow"]);
      const rows = await store
        .select({ record: data.record, updatedBy: data.updatedBy })
        .from(data)
        .where(eq(data.collection, "outbound"));
      expect(rows).toEqual([{ record: { ...lead, stage: "contacted" }, updatedBy: `run:${runId}` }]);
    } finally {
      await pool.end();
    }
  });

  it("decides and records a batch as its entries, each its own save or delete, and denies it whole when one is", async () => {
    const pool = db();
    const store = databaseOn(pool);
    try {
      await store.delete(data).where(eq(data.collection, "outbound"));
      await store.insert(data).values({ collection: "outbound", key: "Acme", record: lead, updatedBy: "leon" });
      const runId = await app.client.start(
        "outbound-batch",
        { companies: ["Acme"], deletes: ["Globex"] },
        { startedBy: { id: "leon" } },
      );
      expect(await app.client.result(runId)).toEqual([
        {
          key: "Acme",
          record: { ...lead, stage: "contacted" },
          updatedAt: expect.any(String),
          updatedBy: `run:${runId}`,
        },
        { key: "Globex", deleted: false },
      ]);
      const made = await calls(runId);
      expect(
        made.map(({ id, seq, op, node, target, input, decision, output }) => ({
          id,
          seq,
          op,
          node,
          target,
          input,
          decision,
          output,
        })),
      ).toEqual([
        {
          id: `${runId}:op.called:1`,
          seq: 1,
          op: "data.outbound.save",
          node: "0",
          target: "data:outbound/Acme",
          input: { record: { ...lead, stage: "contacted" } },
          decision: { kind: "allow", reasons: ["allow-by-default"], policyVersion: expect.any(String) },
          output: {
            key: "Acme",
            record: { ...lead, stage: "contacted" },
            updatedAt: expect.any(String),
            updatedBy: `run:${runId}`,
          },
        },
        {
          id: `${runId}:op.called:2`,
          seq: 2,
          op: "data.outbound.delete",
          node: "0",
          target: "data:outbound/Globex",
          input: { key: "Globex" },
          decision: { kind: "allow", reasons: ["allow-by-default"], policyVersion: expect.any(String) },
          output: { key: "Globex", deleted: false },
        },
      ]);
      // The record's history has the batch's save of it, newest, as it would a save alone.
      expect((await app.client.history("data:outbound/Acme")).map((r) => r.id)[0]).toBe(made[0]!.id);

      // Wayne has no record before it: the policy denies its save, which denies the batch, naming the key.
      const denied = await app.client.start(
        "outbound-batch",
        { companies: ["Acme", "Wayne"] },
        { startedBy: { id: "leon" } },
      );
      await expect(app.client.result(denied)).rejects.toMatchObject({
        code: "policy_denied",
        message: "data.outbound.saveMany was denied by policy: Wayne: a save replaces a lead",
        data: { op: "data.outbound.saveMany", denied: ["Wayne"] },
      });
      expect(
        (await calls(denied)).map(({ seq, op, target, decision, error }) => ({ seq, op, target, decision, error })),
      ).toEqual([
        {
          seq: 1,
          op: "data.outbound.save",
          target: "data:outbound/Acme",
          decision: { kind: "allow", reasons: ["allow-by-default"], policyVersion: expect.any(String) },
          error: expect.objectContaining({ code: "policy_denied" }),
        },
        {
          seq: 2,
          op: "data.outbound.save",
          target: "data:outbound/Wayne",
          decision: expect.objectContaining({ kind: "deny", reason: "a save replaces a lead" }),
          error: expect.objectContaining({ code: "policy_denied" }),
        },
      ]);
      const rows = await store
        .select({ key: data.key, record: data.record })
        .from(data)
        .where(eq(data.collection, "outbound"));
      expect(rows).toEqual([{ key: "Acme", record: { ...lead, stage: "contacted" } }]);
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
      seeds: [{ op: "data.outbound.delete", input: { key: "Acme" }, output: { key: "Acme", deleted: false } }],
    });
    const pool = db();
    try {
      const saved = await databaseOn(pool)
        .select({ key: data.key })
        .from(data)
        .where(
          inArray(
            data.updatedBy,
            runIds.map((id) => `run:${id}`),
          ),
        );
      expect(saved).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
