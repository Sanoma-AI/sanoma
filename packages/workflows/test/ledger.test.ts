import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { jsonlLedger, type LedgerRecord, type LedgerStore, memoryLedger } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "sanoma-ledger-unit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rec = (
  runId: string,
  seq: number,
  type: "run.started" | "run.finished" = "run.started",
  payload: unknown = { seq },
): LedgerRecord =>
  type === "run.started"
    ? { id: `${runId}:${type}:${seq}`, runId, seq, at: seq, actor: "a", workflow: "w", type, input: payload }
    : { id: `${runId}:${type}:${seq}`, runId, seq, at: seq, actor: "a", workflow: "w", type, output: payload };

describe.each<[string, () => LedgerStore]>([
  ["jsonlLedger", () => jsonlLedger(join(dir, "store"))],
  ["memoryLedger", memoryLedger],
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
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${run}:run.finished:1.*differed in output`)));
    warn.mockRestore();
    expect((await store.read(run)).map((r) => (r.type === "run.finished" ? r.output : null))).toEqual([{ seq: 1 }]);
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
    warn.mockRestore();

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

  it("says when the directory does not exist, rather than reading no records", async () => {
    const missing = join(dir, "no-such-dir");
    await expect(jsonlLedger(missing).read("r1")).rejects.toThrow(`Ledger directory ${missing} does not exist`);
  });
});
