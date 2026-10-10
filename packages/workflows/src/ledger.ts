import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Approver, Principal } from "./define.ts";
import { type ErrorInfo, isFinal, keepCode } from "./errors.ts";
import { shown, warn } from "./log.ts";
import type { Effect } from "./op.ts";
import type { RecordedDecision } from "./policy.ts";
import type { Run } from "./run.ts";
import { errorMessage } from "./shared.ts";

/**
 * The audit record of a run: who started it, every operation call with the policy's
 * decision, every approval, and how it ended. Records are append-only.
 *
 * `id` is deterministic (`<runId>:<type>:<seq>`, `<runId>:<type>:<approvalId>` for an
 * approval requested or decided, `<runId>:approval.refused:<approvalId>:refused:<n>` for
 * the nth message an approval ignored) so that when DBOS replays a run after a restart,
 * the records it writes again have the same ids and the store skips them. `seq` orders a
 * run's records. `v` is the record format's version; `app` is the config's `appName`.
 */
export type LedgerRecord = {
  v: 1;
  app: string;
  id: string;
  runId: string;
  seq: number;
  at: number;
  actor: Principal;
  workflow: string;
  /** Set on every record written while a `ctx.all` member runs; absent outside one. */
  group?: LedgerGroup;
} & (
  | { type: "run.started"; input: unknown }
  | {
      type: "op.called";
      op: string;
      /**
       * The outline node of the call that made it (`OutlineNode.path`): where the step is in the
       * code. Absent in records written before the worker placed calls (ledgers from 0.1).
       */
      node?: string;
      effect: Effect;
      input: unknown;
      /** The policy's decision, with its `reasons` and the policy's `policyVersion` when there are any. */
      decision: RecordedDecision;
      output?: unknown;
      /**
       * Why the call failed: `{ code?, name, message }`, and the vendor's `status`, `vendorCode`
       * and `retryable` from a `DriverError`, or the `data` of one of the runtime's errors.
       */
      error?: ErrorInfo;
      durationMs: number;
      /** Which try produced the output or the final error, from 1. Idempotent operations are retried. */
      attempt?: number;
      /** The approval that held the call, when its rejection stopped it. */
      approval?: string;
    }
  | {
      type: "approval.requested";
      approval: string;
      /** The outline node of the `ctx.approval` call, or of the held operation's call for a policy request; as for `op.called`. */
      node?: string;
      title: string;
      approver: Approver;
      requestedBy: "workflow" | "policy";
      /** The operations the approval stands for, by id. */
      covers: string[];
      /** The operation call held, for a policy request. */
      op?: string;
      /** The held call's `seq`, which its `op.called` record has, for a policy request. */
      opSeq?: number;
    }
  /** A message the approval ignored: from someone other than the approver, or not a decision. */
  | { type: "approval.refused"; approval: string; by?: string; reason: string }
  | { type: "approval.decided"; approval: string; decision: "approve" | "reject"; by: string; note?: string }
  /**
   * A `ctx.sleep` began; `until` is when it ends, in ms since the epoch: the time asked for, or
   * for a duration the time the sleep started plus the duration, as the runtime saw it. Written
   * for a time already past too, which waits not at all.
   */
  | { type: "sleep.started"; node?: string; until: number }
  /**
   * A sandbox run seeded its fakes from the scenario named: each `Given` operation called
   * through its fake, with what the fake returned. Follows `run.started`.
   */
  | { type: "scenario.seeded"; scenario: string; seeds: { op: string; input: unknown; output: unknown }[] }
  | { type: "run.finished"; output: unknown }
  /** `error` as for `op.called`. */
  | { type: "run.failed"; error: ErrorInfo }
);

/**
 * The `ctx.all` member a record was written in. `id` is `all:<seq>`, the run's next `seq` when
 * the `ctx.all` began, so a replay names it the same; `index` is the member's position, `size`
 * the member count and `node` the `ctx.all` call's outline node.
 */
export interface LedgerGroup {
  id: string;
  index: number;
  size: number;
  /** The outline node of the `ctx.all` call; as for `op.called`'s. */
  node?: string;
}

/**
 * The `ctx.all` member a call was made in. Each member runs inside `currentGroup.run`, and a
 * queued call keeps the context it was queued in, so a call made outside the member meanwhile
 * (one the workflow did not await) is not tagged as the member's.
 */
export const currentGroup = new AsyncLocalStorage<LedgerGroup>();

export interface LedgerStore {
  /**
   * Adds a record, unless one with the same id is already stored. A failed append is tried
   * again, up to three times. A store throws an error with `retryable: false` for a failure
   * that must not be retried because it would only happen again, such as a corrupt file or a
   * record that can't be written as JSON.
   */
  append(record: LedgerRecord): Promise<void>;
  /** A run's records in `seq` order. */
  read(runId: string): Promise<LedgerRecord[]>;
}

const bySeq = (a: LedgerRecord, b: LedgerRecord) => a.seq - b.seq;

/** An error that trying again would only repeat. */
const final = (message: string, cause: unknown) => Object.assign(new Error(message, { cause }), { retryable: false });

/** JSON for a record, or an error that names the record when it can't be written as JSON (a BigInt, a cycle). */
function serialize(record: LedgerRecord): string {
  try {
    return JSON.stringify(record);
  } catch (cause) {
    const op = record.type === "op.called" ? ` (${record.op})` : "";
    throw final(`Ledger record ${record.id}${op} can't be written as JSON: ${errorMessage(cause)}`, cause);
  }
}

const COMPARED = ["type", "input", "decision", "error", "output"] as const;

/**
 * The first record with an id stands. Says so when a later one with that id differs where it
 * matters, showing both, so a replay that went another way can be told from a retry.
 */
function warnIfDifferent(stored: LedgerRecord, line: string) {
  const later = JSON.parse(line) as Record<string, unknown>;
  const differs = COMPARED.flatMap((k) => {
    const kept = (stored as Record<string, unknown>)[k];
    const sent = later[k];
    return JSON.stringify(kept) === JSON.stringify(sent)
      ? []
      : [`${k} (kept ${shown(kept, 200)}, later ${shown(sent, 200)})`];
  });
  if (differs.length) {
    warn(`ledger: kept the first record ${stored.id}; a later write differed in ${differs.join("; ")}`);
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
      throw final(`${path}:${i + 1}: corrupt ledger line`, cause);
    }
  });
  return complete.length < text.length ? { records, tornAt: Buffer.byteLength(complete) } : { records };
}

/**
 * Keeps each run's records in `<dir>/<runId>.jsonl`, one JSON object per line. A run with no
 * file, or a directory not yet created, reads as no records.
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
            warn(`ledger: ${path} ended in a cut-off line; removed it before appending ${record.id}`);
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
      // A missing directory, like a missing file, means nothing has been recorded there yet:
      // `load` reads either as no records. Any other failure is thrown.
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

type Common = "v" | "app" | "id" | "runId" | "seq" | "at" | "actor" | "workflow" | "group";

/** What one kind of record says, without what every record carries: `type` and its own fields. */
export type LedgerBody = LedgerRecord extends infer R ? (R extends LedgerRecord ? Omit<R, Common> : never) : never;

/** A record of the run, with the next `seq` unless one is given, tagged with the `ctx.all` member it is written in. */
export function entry(
  run: Run,
  body: LedgerBody,
  opts: { seq?: number; key?: string; at?: number } = {},
): LedgerRecord {
  const seq = opts.seq ?? run.seq++;
  const record = {
    v: 1,
    app: run.state.app,
    id: `${run.id}:${body.type}:${opts.key ?? seq}`,
    runId: run.id,
    seq,
    at: opts.at ?? Date.now(),
    actor: run.actor,
    workflow: run.workflow,
    ...body,
  } as LedgerRecord;
  const group = currentGroup.getStore();
  if (group) record.group = group;
  return record;
}

// Waits between tries of a failed append. Safe to repeat: append is idempotent by id.
const RETRY_DELAYS_MS = [50, 200, 800];

async function append(run: Run, record: LedgerRecord) {
  for (let i = 0; ; i++) {
    try {
      return await run.state.ledger.append(record);
    } catch (err) {
      const wait = RETRY_DELAYS_MS[i];
      if (wait === undefined || isFinal(err)) throw err;
      warn(`ledger: appending ${record.id} failed (${errorMessage(err)}); trying again in ${wait} ms`);
      await delay(wait);
    }
  }
}

/*
 * Every ledger write happens outside DBOS steps. When DBOS replays a run after a restart,
 * it re-runs the workflow function and these writes happen again with the same ids, so
 * the store keeps one of each and fills in any the interrupted run never got to write.
 */
export async function write(run: Run, record: LedgerRecord) {
  await append(run, record);
}

/**
 * Records a failure. If the ledger fails too, throws both, so neither is lost, with the
 * original's code: the run still fails the way it did.
 */
export async function writeFailure(run: Run, record: LedgerRecord, original: unknown) {
  try {
    await append(run, record);
  } catch (ledgerError) {
    throw keepCode(
      new AggregateError(
        [original, ledgerError],
        `${errorMessage(original)} (and the ledger could not record ${record.id}: ${errorMessage(ledgerError)})`,
        { cause: ledgerError },
      ),
      original,
    );
  }
}

/** Says that a record was deliberately not written, and why. */
export function skipped(record: LedgerRecord, why: string) {
  warn(`did not write ${record.type} ${record.id}: ${why}`);
}
