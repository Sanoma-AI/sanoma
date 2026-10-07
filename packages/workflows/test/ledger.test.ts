import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { jsonlLedger, type LedgerRecord, type LedgerStore, memoryLedger } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "sanoma-ledger-unit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rec = (runId: string, seq: number, type: "run.started" | "run.finished" = "run.started"): LedgerRecord =>
  type === "run.started"
    ? { id: `${runId}:${type}:${seq}`, runId, seq, at: seq, actor: "a", workflow: "w", type, input: { seq } }
    : { id: `${runId}:${type}:${seq}`, runId, seq, at: seq, actor: "a", workflow: "w", type, output: { seq } };

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
