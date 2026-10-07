import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect } from "./op.ts";
import type { Decision } from "./policy.ts";

/**
 * The audit record of a run: who started it, every operation call with the policy's
 * decision, every approval, and how it ended. Records are append-only.
 *
 * `id` is deterministic (`<runId>:<type>:<seq>`, or `<runId>:<type>:<approvalId>` for
 * approvals) so that when DBOS replays a run after a restart, the records it writes
 * again have the same ids and the store skips them. `seq` orders a run's records.
 */
export type LedgerRecord = {
  id: string;
  runId: string;
  seq: number;
  at: number;
  actor: string;
  workflow: string;
} & (
  | { type: "run.started"; input: unknown }
  | {
      type: "op.called";
      op: string;
      effect: Effect;
      input: unknown;
      decision: Decision;
      output?: unknown;
      error?: string;
      durationMs: number;
    }
  | { type: "approval.requested"; approval: string; title: string; approver: string }
  | { type: "approval.decided"; approval: string; decision: "approve" | "reject"; by: string; note?: string }
  | { type: "run.finished"; output: unknown }
  | { type: "run.failed"; error: string }
);

export interface LedgerStore {
  /** Adds a record, unless one with the same id is already stored. */
  append(record: LedgerRecord): Promise<void>;
  /** A run's records in `seq` order. */
  read(runId: string): Promise<LedgerRecord[]>;
}

const bySeq = (a: LedgerRecord, b: LedgerRecord) => a.seq - b.seq;

/** Keeps each run's records in `<dir>/<runId>.jsonl`, one JSON object per line. */
export function jsonlLedger(dir: string): LedgerStore {
  const file = (runId: string) => join(dir, `${encodeURIComponent(runId)}.jsonl`);
  // Appends to one file are serialized, so the id check and the write can't interleave.
  const queues = new Map<string, Promise<unknown>>();

  const load = async (runId: string): Promise<LedgerRecord[]> => {
    let text: string;
    try {
      text = await readFile(file(runId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as LedgerRecord);
  };

  return {
    append(record) {
      const path = file(record.runId);
      const next = (queues.get(path) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          if ((await load(record.runId)).some((r) => r.id === record.id)) return;
          await mkdir(dir, { recursive: true });
          await appendFile(path, `${JSON.stringify(record)}\n`);
        });
      queues.set(path, next);
      return next;
    },
    async read(runId) {
      await queues.get(file(runId))?.catch(() => {});
      return (await load(runId)).toSorted(bySeq);
    },
  };
}

/** Keeps records in memory, for tests. */
export function memoryLedger(): LedgerStore {
  const runs = new Map<string, Map<string, LedgerRecord>>();
  return {
    async append(record) {
      let run = runs.get(record.runId);
      if (!run) runs.set(record.runId, (run = new Map()));
      if (!run.has(record.id)) run.set(record.id, JSON.parse(JSON.stringify(record)));
    },
    async read(runId) {
      return [...(runs.get(runId)?.values() ?? [])].map((r) => structuredClone(r)).toSorted(bySeq);
    },
  };
}
