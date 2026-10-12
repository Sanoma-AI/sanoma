import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { testDatabaseUrl } from "@sanoma/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  allowAll,
  defineConnector,
  defineWorkflow,
  errorCode,
  jsonlLedger,
  jsonlLines,
  type LedgerRecord,
  type LedgerStore,
  memoryLedger,
  PolicyDeniedError,
  postgresLedger,
  resolveConfig,
  type SanomaConfig,
} from "../src/index.ts";
import { currentGroup, entry, write, writeFailure } from "../src/ledger.ts";
import type { Run } from "../src/run.ts";

const dir = mkdtempSync(join(tmpdir(), "sanoma-ledger-unit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const databaseUrl = testDatabaseUrl("ledger");
/** One Postgres store for the file, as the worker, the app and the client share one. */
const postgres = postgresLedger(databaseUrl);
// The database, which a worker's launch would have made; the store makes only its table.
beforeAll(() => DBOS.migrate(databaseUrl));
afterAll(() => postgres.close!());

const rec = (
  runId: string,
  seq: number,
  type: "run.started" | "run.finished" = "run.started",
  payload: unknown = { seq },
): LedgerRecord => {
  const header = {
    v: 1,
    app: "test",
    id: `${runId}:${type}:${seq}`,
    runId,
    seq,
    at: seq,
    actor: { id: "a" },
    workflow: "w",
  } as const;
  return type === "run.started" ? { ...header, type, input: payload } : { ...header, type, output: payload };
};

describe.each<[string, () => LedgerStore]>([
  ["jsonlLedger", () => jsonlLedger(join(dir, "store"))],
  ["memoryLedger", memoryLedger],
  ["postgresLedger", () => postgres],
])("%s", (_, make) => {
  it("keeps the first record with an id and reads a run back in seq order", async () => {
    const store = make();
    const run = randomUUID();
    await store.append(rec(run, 2, "run.finished"));
    await store.append(rec(run, 0));
    await store.append({ ...rec(run, 0), at: 999 });
    await Promise.all([store.append(rec(run, 1)), store.append(rec(run, 1))]);
    await store.append(rec("other", 0));

    const records = await store.read(run);
    expect(records.map((r) => r.id)).toEqual([`${run}:run.started:0`, `${run}:run.started:1`, `${run}:run.finished:2`]);
    expect(records[0]?.at).toBe(0);
    expect(await store.read("never-ran")).toEqual([]);
  });

  it("names the record when it can't be written as JSON, and warns when a repeat id differs", async () => {
    const store = make();
    const run = randomUUID();
    await expect(store.append(rec(run, 0, "run.finished", { n: 1n }))).rejects.toThrow(
      `Ledger record ${run}:run.finished:0 can't be written as JSON`,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.append(rec(run, 1, "run.finished"));
    await store.append({ ...rec(run, 1, "run.finished"), at: 5 });
    expect(warn).not.toHaveBeenCalled();
    await store.append(rec(run, 1, "run.finished", { seq: 2 }));
    expect(warn).toHaveBeenCalledWith(
      `sanoma: ledger: kept the first record ${run}:run.finished:1; a later write differed in output (kept {"seq":1}, later {"seq":2})`,
    );
    warn.mockClear();
    // The input counts too: a replay that started with other input went another way.
    await store.append(rec(run, 3, "run.started", "x".repeat(300)));
    await store.append(rec(run, 3, "run.started", "y"));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/differed in input \(kept "x{199}…, later "y"\)$/));
    // The same value with its keys in another order is the same record.
    warn.mockClear();
    await store.append(rec(run, 4, "run.finished", { b: 1, a: { d: 2, c: 3 } }));
    await store.append(rec(run, 4, "run.finished", { a: { c: 3, d: 2 }, b: 1 }));
    expect(warn).not.toHaveBeenCalled();
    expect((await store.read(run)).flatMap((r) => (r.type === "run.finished" ? [r.output] : []))).toEqual([
      { seq: 1 },
      { b: 1, a: { d: 2, c: 3 } },
    ]);
  });
});

describe("postgresLedger", () => {
  it("creates its table on first use, which another store on the database then shares", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const stores = [postgresLedger(databaseUrl), postgresLedger(databaseUrl)];
    try {
      await pool.query("DROP TABLE IF EXISTS sanoma_ledger");
      const run = randomUUID();
      // Two writers at once, each on a pool of its own (two processes), both making the table.
      await Promise.all(stores.map((store, seq) => store.append(rec(run, seq))));
      expect((await pool.query("SELECT to_regclass('sanoma_ledger')::text AS t")).rows).toEqual([
        { t: "sanoma_ledger" },
      ]);
      expect((await stores[1]!.read(run)).map((r) => r.seq)).toEqual([0, 1]);
    } finally {
      for (const store of stores) await store.close!();
      await pool.end();
    }
  });

  it("keeps the first of two writers of one id, and reads records of one seq in write order", async () => {
    const other = postgresLedger(databaseUrl);
    try {
      const run = randomUUID();
      const first = rec(run, 0);
      await Promise.all([postgres.append(first), other.append({ ...first, at: 999 })]);
      const [kept] = await other.read(run);
      expect([0, 999]).toContain(kept!.at);
      // Two records numbered the same (an approval's and its call's): the one written first reads first.
      await postgres.append({ ...rec(run, 1, "run.finished"), id: `${run}:b` });
      await postgres.append({ ...rec(run, 1, "run.finished"), id: `${run}:a` });
      expect((await postgres.read(run)).map((r) => r.id)).toEqual([first.id, `${run}:b`, `${run}:a`]);
    } finally {
      await other.close!();
    }
  });

  it("refuses a record Postgres cannot store as final, without retrying", async () => {
    const run = randomUUID();
    const err = await postgres.append(rec(run, 0, "run.started", "nul\u0000here")).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: expect.stringContaining(`Ledger record ${run}:run.started:0 can't be stored`),
    });
    expect(err).toMatchObject({ retryable: false });
    expect(await postgres.read(run)).toEqual([]);
  });

  it("releases its pool on close, opens another on the next use, and may be closed again", async () => {
    const end = vi.spyOn(Pool.prototype, "end");
    const store = postgresLedger(databaseUrl);
    await store.append(rec("closing", 0));
    await store.close!();
    expect(end).toHaveBeenCalledTimes(1);
    expect((await store.read("closing")).map((r) => r.seq)).toEqual([0]);
    await store.close!();
    await store.close!();
    expect(end).toHaveBeenCalledTimes(2);
  });

  it("fails saying so when the database does not exist, rather than making it", async () => {
    const store = postgresLedger(testDatabaseUrl("ledger_nowhere"));
    try {
      await expect(store.read("r")).rejects.toThrow(/^could not prepare the ledger table: .*does not exist/);
    } finally {
      await store.close!();
    }
  });
});

const noop = defineWorkflow({ name: "noop", trigger: "manual", input: z.object({}), uses: [], run: async () => 1 });
const minimal = (): SanomaConfig => ({
  workflows: [noop],
  connectors: [defineConnector("none", {})],
  drivers: [],
  policy: allowAll,
  databaseUrl,
});

describe("resolveConfig without a ledger", () => {
  it("uses the Postgres store on the config's database, the same one each time for one config", async () => {
    const config = minimal();
    const { ledger } = resolveConfig(config);
    expect(resolveConfig(config).ledger).toBe(ledger);
    expect(resolveConfig({ ...config }).ledger).not.toBe(ledger);
    expect(resolveConfig(minimal()).ledger).not.toBe(ledger);
    try {
      const run = randomUUID();
      await ledger.append(rec(run, 0));
      expect((await postgres.read(run)).map((r) => r.id)).toEqual([`${run}:run.started:0`]);
    } finally {
      await ledger.close!();
    }
  });

  it("refuses a ledger that is not a store", () => {
    expect(() => resolveConfig({ ...minimal(), ledger: { read: 1 } as never })).toThrow(
      /^The config's `ledger` must be a ledger store: leave it out for `postgresLedger`/,
    );
  });
});

describe("jsonlLines", () => {
  it("is the format jsonlLedger writes, one record per line", async () => {
    const records = [rec("j1", 0), rec("j1", 1, "run.finished")];
    const store = jsonlLedger(join(dir, "lines"));
    for (const r of records) await store.append(r);
    expect(jsonlLines(records)).toBe(readFileSync(join(dir, "lines", "j1.jsonl"), "utf8"));
    expect(jsonlLines([])).toBe("");
    expect(() => jsonlLines([rec("j1", 2, "run.finished", { n: 1n })])).toThrow("can't be written as JSON");
  });
});

describe("jsonlLedger", () => {
  it("writes one JSON object per line to <dir>/<runId>.jsonl, creating the directory", async () => {
    const store = jsonlLedger(join(dir, "nested", "ledger"));
    await store.append(rec("r1", 0));
    await store.append(rec("r1", 1, "run.finished"));
    const lines = readFileSync(join(dir, "nested", "ledger", "r1.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["run.started", "run.finished"]);
    // A second store on the same directory (another process, or a restarted worker) still dedupes.
    await jsonlLedger(join(dir, "nested", "ledger")).append(rec("r1", 0));
    expect(await store.read("r1")).toHaveLength(2);
  });
});

const line = (r: LedgerRecord) => `${JSON.stringify(r)}\n`;

describe("jsonlLedger on a damaged file", () => {
  it("ignores a line cut off mid-write, and removes it before the next append", async () => {
    const store = jsonlLedger(join(dir, "torn"));
    mkdirSync(join(dir, "torn"), { recursive: true });
    const path = join(dir, "torn", "t1.jsonl");
    writeFileSync(path, line(rec("t1", 0)) + line(rec("t1", 1)) + line(rec("t1", 2)).slice(0, 25));

    expect((await store.read("t1")).map((r) => r.seq)).toEqual([0, 1]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.append(rec("t1", 2));
    await store.append(rec("t1", 3, "run.finished"));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cut-off line/));

    expect((await store.read("t1")).map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2, 3]);
  });

  it("throws with the path and line number when a complete line is not JSON", async () => {
    const store = jsonlLedger(join(dir, "corrupt"));
    await store.append(rec("c1", 0));
    const path = join(dir, "corrupt", "c1.jsonl");
    appendFileSync(path, `{"oops\n${line(rec("c1", 2))}`);
    await expect(store.read("c1")).rejects.toThrow(`${path}:2: corrupt ledger line`);
    await expect(store.append(rec("c1", 3))).rejects.toThrow(/corrupt ledger line/);
  });

  it("reads no records from a directory nothing has written to yet, as from a missing file", async () => {
    expect(await jsonlLedger(join(dir, "missing")).read("r1")).toEqual([]);
  });
});

/** A store whose first `failures` appends throw. */
const flaky = (failures: number) => {
  const store = memoryLedger();
  let calls = 0;
  return {
    calls: () => calls,
    store: {
      read: store.read,
      async append(record: LedgerRecord) {
        if (++calls <= failures) throw new Error(`disk full (${calls})`);
        await store.append(record);
      },
    } satisfies LedgerStore,
  };
};
const runOn = (ledger: LedgerStore): Run => ({
  id: randomUUID(),
  workflow: "w",
  actor: { id: "alice", groups: ["ops"] },
  approvals: [],
  seq: 0,
  tail: Promise.resolve(),
  inAll: false,
  ended: false,
  outline: { file: "w.ts", lineStarts: [0, 1], calls: [] },
  state: {
    app: "acme",
    ops: new Map(),
    drivers: new Map(),
    envs: new Map(),
    fakes: new Map(),
    fakeDrivers: new Map(),
    policy: allowAll,
    ledger,
    workflows: new Map(),
    outlines: new Map(),
    stopped: false,
  },
});

describe("writing a run's records", () => {
  it("stamps the format version, the app and the run's actor, and counts seq", () => {
    const run = runOn(memoryLedger());
    expect(entry(run, { type: "run.started", input: 1 }, { at: 5 })).toEqual({
      v: 1,
      app: "acme",
      id: `${run.id}:run.started:0`,
      runId: run.id,
      seq: 0,
      at: 5,
      actor: { id: "alice", groups: ["ops"] },
      workflow: "w",
      type: "run.started",
      input: 1,
    });
    expect(entry(run, { type: "run.finished", output: 2 }).seq).toBe(1);
  });

  it("tags a record with the ctx.all member it is written in, and only then", () => {
    const run = runOn(memoryLedger());
    const group = { id: "all:1", index: 1, size: 2 };
    expect(currentGroup.run(group, () => entry(run, { type: "run.started", input: 1 }))).toMatchObject({ group });
    expect(entry(run, { type: "run.finished", output: 2 })).not.toHaveProperty("group");
  });

  it("retries a failed append, so a store failing twice then succeeding loses nothing", async () => {
    const { store, calls } = flaky(2);
    const run = runOn(store);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await write(run, entry(run, { type: "run.started", input: null }));
    expect(calls()).toBe(3);
    expect(await store.read(run.id)).toHaveLength(1);
    // Said once per retry, naming the record.
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      expect.stringMatching(new RegExp(`appending ${run.id}:run.started:0 failed .*trying again in 50 ms`)),
      expect.stringMatching(/trying again in 200 ms/),
    ]);
  });

  it("does not retry what would fail again: a record that isn't JSON, or a store error marked retryable: false", async () => {
    const { store, calls } = flaky(0);
    const run = runOn(store);
    await expect(write(run, entry(run, { type: "run.started", input: 1n }))).rejects.toThrow(
      "can't be written as JSON",
    );
    // The store refuses it as final on the first try.
    expect(calls()).toBe(1);

    let tries = 0;
    const corrupt: LedgerStore = {
      read: store.read,
      async append() {
        tries++;
        throw Object.assign(new Error("corrupt ledger line"), { retryable: false });
      },
    };
    const other = runOn(corrupt);
    await expect(write(other, entry(other, { type: "run.started", input: null }))).rejects.toThrow("corrupt");
    // Tried once: no retry, so no wait.
    expect(tries).toBe(1);
  });

  it("gives up after three retries, and a failure record then throws both errors", async () => {
    const { store, calls } = flaky(10);
    const run = runOn(store);
    await expect(write(run, entry(run, { type: "run.started", input: null }))).rejects.toThrow("disk full (4)");
    expect(calls()).toBe(4);
    const original = new PolicyDeniedError("shop.order.refund", "not today");
    const record = entry(run, { type: "run.failed", error: { name: "Error", message: original.message } });
    const err = await writeFailure(run, record, original).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as Error).message).toBe(
      `shop.order.refund was denied by policy: not today (and the ledger could not record ${record.id}: disk full (8))`,
    );
    // Still the denial, by code: the run fails the way it did.
    expect(errorCode(err)).toBe("policy_denied");
    expect(err).toMatchObject({ data: { op: "shop.order.refund", reason: "not today" } });
  });
});
