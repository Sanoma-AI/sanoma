import { appendFile, mkdir, readFile, stat, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** JSON for a record, or an error that names the record when it can't be written as JSON (a BigInt, a cycle). */
function serialize(record: LedgerRecord): string {
  try {
    return JSON.stringify(record);
  } catch (cause) {
    const op = record.type === "op.called" ? ` (${record.op})` : "";
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Ledger record ${record.id}${op} can't be written as JSON: ${why}`, { cause });
  }
}

const COMPARED = ["type", "decision", "error", "output"] as const;

/** The first record with an id stands. Says so when a later one with that id differs where it matters. */
function warnIfDifferent(stored: LedgerRecord, line: string) {
  const later = JSON.parse(line) as Record<string, unknown>;
  const differs = COMPARED.filter(
    (k) => JSON.stringify((stored as Record<string, unknown>)[k]) !== JSON.stringify(later[k]),
  );
  if (differs.length) {
    console.warn(`sanoma ledger: kept the first record ${stored.id}; a later write differed in ${differs.join(", ")}`);
  }
}

/** The file's complete records, and the length of its complete lines when a cut-off line follows them. */
async function load(path: string): Promise<{ records: LedgerRecord[]; tornAt?: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
    throw err;
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const records: LedgerRecord[] = [];
  complete.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch (cause) {
      throw new Error(`${path}:${i + 1}: corrupt ledger line`, { cause });
    }
  });
  return complete.length < text.length ? { records, tornAt: Buffer.byteLength(complete) } : { records };
}

/**
 * Keeps each run's records in `<dir>/<runId>.jsonl`, one JSON object per line.
 *
 * A line with no newline at the end of a file is a write that was cut off (the process
 * died mid-append): reads ignore it, and the next append removes it before writing.
 * A line that isn't JSON anywhere else is corruption, and reads throw.
 */
export function jsonlLedger(dir: string): LedgerStore {
  const root = resolve(dir);
  const file = (runId: string) => join(root, `${encodeURIComponent(runId)}.jsonl`);
  // Appends to one file are serialized, so the id check and the write can't interleave.
  const queues = new Map<string, Promise<unknown>>();

  return {
    append(record) {
      const path = file(record.runId);
      const next = (queues.get(path) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const line = serialize(record);
          const { records, tornAt } = await load(path);
          const stored = records.find((r) => r.id === record.id);
          if (stored) return warnIfDifferent(stored, line);
          await mkdir(root, { recursive: true });
          if (tornAt !== undefined) {
            console.warn(`sanoma ledger: ${path} ended in a cut-off line; removed it before appending ${record.id}`);
            await truncate(path, tornAt);
          }
          await appendFile(path, `${line}\n`);
        });
      queues.set(path, next);
      const forget = () => {
        if (queues.get(path) === next) queues.delete(path);
      };
      next.then(forget, forget);
      return next;
    },
    async read(runId) {
      const path = file(runId);
      await queues.get(path)?.catch(() => {});
      try {
        await stat(root);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(
            `Ledger directory ${root} does not exist (no run has written to it, or it is the wrong path)`,
            { cause },
          );
        }
        throw cause;
      }
      // A case-insensitive file system can map two run ids to one file.
      return (await load(path)).records.filter((r) => r.runId === runId).toSorted(bySeq);
    },
  };
}

/** Keeps records in memory, for tests. */
export function memoryLedger(): LedgerStore {
  const runs = new Map<string, Map<string, LedgerRecord>>();
  return {
    async append(record) {
      const line = serialize(record);
      let run = runs.get(record.runId);
      if (!run) runs.set(record.runId, (run = new Map()));
      const stored = run.get(record.id);
      if (stored) warnIfDifferent(stored, line);
      else run.set(record.id, JSON.parse(line));
    },
    async read(runId) {
      return [...(runs.get(runId)?.values() ?? [])].map((r) => structuredClone(r)).toSorted(bySeq);
    },
  };
}
