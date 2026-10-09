import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DBOSClient, Error as DBOSErrors, type WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import type { z } from "zod";
import { APPROVALS_EVENT, ApprovalMessage, decisionEventOf, messageKeyOf, topicOf } from "./approvals.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { type ApprovalState, notApprover, Principal, type WorkflowDefinition } from "./define.ts";
import { parseOrThrow, SanomaError } from "./errors.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { RunArgs } from "./run.ts";
import { isEnded, mayDecide, type RunStatus } from "./shared.ts";

/**
 * The run status each DBOS status maps to. `waiting` is PENDING with an approval pending, so
 * only the approvals tell it from `running`. Keyed by every DBOS status, so one a later DBOS
 * adds fails to compile here until it is mapped.
 */
const FROM_DBOS: Record<WorkflowStatusString, Exclude<RunStatus, "waiting">> = {
  ENQUEUED: "queued",
  DELAYED: "queued",
  PENDING: "running",
  SUCCESS: "finished",
  ERROR: "failed",
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: "failed",
  CANCELLED: "cancelled",
};

/** A run's status from DBOS's, and whether it has an approval pending. */
export function runStatus(dbosStatus: string, approvals: readonly ApprovalState[]): RunStatus {
  // A status this DBOS did not have when the table was written: not ended as far as we know.
  const status = Object.hasOwn(FROM_DBOS, dbosStatus) ? FROM_DBOS[dbosStatus as WorkflowStatusString] : "running";
  return status === "running" && approvals.some((a) => a.status === "pending") ? "waiting" : status;
}

/** The DBOS statuses the run statuses come from; `running` and `waiting` both come from PENDING. */
export const dbosStatusesOf = (...statuses: RunStatus[]): WorkflowStatusString[] =>
  (Object.keys(FROM_DBOS) as WorkflowStatusString[]).filter((s) =>
    statuses.some((status) => FROM_DBOS[s] === (status === "waiting" ? "running" : status)),
  );

/**
 * The first `limit` items `keep` accepts, read a page of `pageSize` at a time from `list`, in
 * its order, until there are enough or a page comes back short (the last one).
 */
export async function firstMatching<T>(
  list: (page: { limit: number; offset: number }) => Promise<T[]>,
  keep: (item: T) => boolean,
  limit: number,
  pageSize: number,
): Promise<T[]> {
  const found: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await list({ limit: pageSize, offset });
    found.push(...rows.filter(keep));
    if (found.length >= limit || rows.length < pageSize) return found.slice(0, limit);
  }
}

/** Which runs `SanomaClient.runs` lists. */
export interface RunsFilter {
  /** At most this many, newest first. Defaults to 20. */
  limit?: number;
  /** Only runs with this status. */
  status?: RunStatus;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  /** Who started the run, as passed to `start`. */
  startedBy?: Principal;
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  error?: string;
  /** For a sandbox run, the scenario it was seeded from. */
  sandbox?: string;
}

export interface StartOptions {
  /** Recorded as the run's actor in the ledger and passed to the policy. */
  startedBy: Principal;
  /**
   * Use this run id instead of a new one, so a retried start makes one run. Starting an id
   * that exists returns it, without starting another, when the workflow, the input (compared
   * as JSON), `startedBy` and `sandbox` are the same, and throws `invalid_input` naming what differs
   * when they are not. Of two starts racing with one new id, the first's run stands.
   */
  runId?: string;
  /**
   * Start a sandbox run, seeded from the config's scenario of this name: it calls the config's
   * `fakes` instead of the drivers and does not wait on sleeps. Sandbox runs go on their own
   * queue, one at a time per worker: another waits, queued, until the one before it ends.
   */
  sandbox?: string;
}

/** Talks to the runtime from another process (the app, a script), through the shared Postgres. */
export class SanomaClient {
  private readonly dbos: DBOSClient;
  private readonly config: ResolvedConfig;

  private constructor(dbos: DBOSClient, config: ResolvedConfig) {
    this.dbos = dbos;
    this.config = config;
  }

  /**
   * Connects to the runtime's Postgres for the config's app. Checks the config first and throws
   * what the worker would refuse. Reads ledgers from the config's ledger store.
   */
  static async connect(config: SanomaConfig): Promise<SanomaClient> {
    const resolved = resolveConfig(config);
    const dbos = await DBOSClient.create({
      systemDatabaseUrl: resolved.databaseUrl,
      applicationName: resolved.appName,
    });
    return new SanomaClient(dbos, resolved);
  }

  /**
   * Checks the input against the workflow's schema, then queues a run for the worker. The run
   * gets the input as sent, not as the schema parsed it: the worker parses it once, so a schema
   * with a `.transform` or a default sees the caller's value, and `run.started` records it.
   */
  async start<S extends z.ZodType>(
    workflow: WorkflowDefinition<any, S>,
    input: z.input<S>,
    options: StartOptions,
  ): Promise<string> {
    parseOrThrow(workflow.input, input, `The input does not match ${workflow.name}'s schema`);
    const startedBy = parseOrThrow(
      Principal,
      options?.startedBy,
      '`startedBy` must be a principal, such as { id: "alice" }',
    );
    const { runId, sandbox } = options;
    const args: RunArgs = { input, startedBy, ...(sandbox === undefined ? {} : { sandbox }) };
    // An id DBOS has already returns that run, unless it is another workflow's, which DBOS refuses.
    const handle = await this.dbos
      .enqueue(
        {
          queueName: sandbox === undefined ? this.config.queueName : this.config.sandboxQueueName,
          workflowName: workflow.name,
          workflowID: runId,
          applicationName: this.config.appName,
          authenticatedUser: startedBy.id,
          authenticatedRoles: startedBy.groups ?? [],
          // Kept on the run's status row too, so a listing tells sandbox runs apart without its input.
          ...(sandbox === undefined ? {} : { attributes: { sandbox } }),
        },
        args,
      )
      .catch((err: unknown) => {
        if (runId !== undefined && err instanceof DBOSErrors.DBOSConflictingWorkflowError) {
          throw new SanomaError(
            "invalid_input",
            `Run ${runId} already exists as another workflow than ${workflow.name}; use another run id`,
            { runId, differs: ["workflow"] },
            { cause: err },
          );
        }
        throw err;
      });
    // After the enqueue, not before: of two starts racing with one new id, the first's run stands.
    if (runId !== undefined) await this.mustMatch(runId, args);
    return handle.workflowID;
  }

  /** The run's audit record, in order, from the config's ledger store. */
  async ledger(runId: string): Promise<LedgerRecord[]> {
    await this.mustExist(runId);
    return this.config.ledger.read(runId);
  }

  /**
   * The app's runs, newest first: the latest `limit`, or the latest `limit` with a `status`.
   * Only the approvals tell `running` from `waiting`, so those read PENDING runs a page at a
   * time until `limit` have that status.
   */
  async runs({ limit = 20, status }: RunsFilter = {}): Promise<RunSummary[]> {
    const list = (more: { limit: number; offset?: number }) =>
      this.dbos.listWorkflows({
        ...more,
        status: status && dbosStatusesOf(status),
        sortDesc: true,
        applicationName: this.config.appName,
        loadInput: false,
        // The output holds the error a summary shows; only an ended run can have one.
        loadOutput: status === undefined || status === "failed" || status === "cancelled",
      });
    if (status !== "running" && status !== "waiting") {
      return Promise.all((await list({ limit })).map((r) => this.summarize(r)));
    }
    return firstMatching(
      async (page) => Promise.all((await list(page)).map((r) => this.summarize(r))),
      (run) => run.status === status,
      limit,
      Math.max(limit * 2, 50),
    );
  }

  async run(runId: string): Promise<RunSummary | undefined> {
    const row = await this.dbos.getWorkflow(runId);
    return row && this.summarize(row);
  }

  async approvals(runId: string): Promise<ApprovalState[]> {
    return (await this.dbos.getEvent<ApprovalState[]>(runId, APPROVALS_EVENT, 0)) ?? [];
  }

  /**
   * Sends a decision on the run's pending approval (or the one named), as `message.by`, and
   * waits for the run to read it. Returns the approval as decided. Throws without sending when
   * it is decided already (`already_decided`), when the run has finished, failed or been
   * cancelled (`run_ended`), when there is nothing to decide (`no_pending_approval`,
   * `run_not_found`), or when `by` may not decide it (`not_approver`); and throws
   * `already_decided` too when another decision reached the run first, and `not_approver` when
   * the run read this one and refused it.
   *
   * If the run does not read the decision within `timeoutSeconds` (30 by default; the worker
   * may be down), returns the approval as it stands, still `pending`: the decision stays
   * queued for the run, which reads it when it next runs.
   */
  async decide(
    runId: string,
    message: ApprovalMessage,
    approvalId?: string,
    options: { timeoutSeconds?: number } = {},
  ): Promise<ApprovalState> {
    const msg = parseOrThrow(ApprovalMessage, message, "Not a decision");
    // A run that does not exist has no approvals, so run_not_found never hides already_decided.
    const [all, row] = await Promise.all([this.approvals(runId), this.mustExist(runId)]);
    const target = approvalId ? all.find((a) => a.id === approvalId) : all.find((a) => a.status === "pending");
    if (target && target.status !== "pending") throw alreadyDecided(runId, target);
    // A run that has ended reads no more messages: a decision sent to it would wait forever.
    const status = runStatus(row.status, all);
    if (isEnded(status)) {
      throw new SanomaError("run_ended", `Run ${runId} has ${status}; it takes no more decisions`, {
        runId,
        status,
        ...(target ? { approvalId: target.id } : {}),
      });
    }
    if (!target) {
      throw new SanomaError(
        "no_pending_approval",
        `Run ${runId} has no pending approval${approvalId ? ` "${approvalId}"` : ""}`,
        { runId, ...(approvalId ? { approvalId } : {}) },
      );
    }
    if (!mayDecide(target, msg.by)) {
      throw new SanomaError("not_approver", `${notApprover(target, msg.by)} (${target.id})`, {
        runId,
        approvalId: target.id,
        approver: target.approver,
      });
    }
    // The id names this message, so the run's answer says whether it decided with it, and is
    // in its idempotency key, so a retried send queues it once.
    const id = msg.id ?? randomUUID();
    await this.dbos.send(runId, { ...msg, id }, topicOf(target.id), messageKeyOf(target.id, id));
    // DBOSClient does not LISTEN for events: it polls, every 10 s unless told otherwise. A
    // running worker answers within moments, so poll often at first, then once a second.
    const event = decisionEventOf(target.id);
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const soon = Math.min(2, timeoutSeconds);
    const decided =
      (await this.dbos.getEvent<ApprovalState>(runId, event, { timeoutSeconds: soon, pollingIntervalMs: 100 })) ??
      (timeoutSeconds > soon
        ? await this.dbos.getEvent<ApprovalState>(runId, event, {
            timeoutSeconds: timeoutSeconds - soon,
            pollingIntervalMs: 1000,
          })
        : null);
    const now = decided ?? (await this.approvals(runId)).find((a) => a.id === target.id) ?? target;
    // Read, but refused: the run checks the sender again, and said no.
    const refused = now.refused.find((r) => r.id === id);
    if (refused) {
      throw new SanomaError("not_approver", `${refused.reason} (${target.id})`, {
        runId,
        approvalId: target.id,
        approver: target.approver,
      });
    }
    if (now.status !== "pending" && now.decidedWith !== id) throw alreadyDecided(runId, now);
    return now;
  }

  /**
   * The run's output once it ends, or its error. Throws `run_running` when it has not ended
   * within `timeoutMs`; the run goes on.
   */
  async result(runId: string, timeoutMs = 30_000): Promise<unknown> {
    await this.mustExist(runId);
    const running = () =>
      new SanomaError("run_running", `Run ${runId} is still running after ${timeoutMs} ms`, { runId, timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.dbos.retrieveWorkflow(runId).getResult(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(running()), timeoutMs).unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  close() {
    return this.dbos.destroy();
  }

  /** Refuses a run id whose run, as stored, was started with another input, by someone else, or in another sandbox. */
  private async mustMatch(runId: string, args: RunArgs) {
    const [stored] = ((await this.dbos.getWorkflow(runId))?.input ?? []) as [RunArgs?];
    const differs = (["input", "startedBy", "sandbox"] as const).filter(
      (key) => !stored || !sameJson(stored[key], args[key]),
    );
    if (differs.length) {
      throw new SanomaError(
        "invalid_input",
        `Run ${runId} already exists with a different ${differs.join(", ")}; use another run id`,
        { runId, differs },
      );
    }
  }

  /** The run's status row, read without its input or output, or `run_not_found`. */
  private async mustExist(runId: string) {
    const [row] = await this.dbos.listWorkflows({ workflowIDs: [runId], loadInput: false, loadOutput: false });
    if (!row) throw new SanomaError("run_not_found", `No run ${runId}`, { runId });
    return row;
  }

  private async summarize(r: {
    workflowID: string;
    workflowName: string;
    status: string;
    createdAt: number;
    updatedAt?: number;
    authenticatedUser?: string;
    authenticatedRoles?: string[];
    error?: unknown;
    attributes?: Record<string, unknown>;
  }): Promise<RunSummary> {
    const approvals = await this.approvals(r.workflowID);
    const groups = r.authenticatedRoles ?? [];
    return {
      runId: r.workflowID,
      workflow: r.workflowName,
      status: runStatus(r.status, approvals),
      startedBy: r.authenticatedUser ? { id: r.authenticatedUser, ...(groups.length ? { groups } : {}) } : undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvals,
      error: r.error ? String((r.error as Error).message ?? r.error) : undefined,
      ...(typeof r.attributes?.sandbox === "string" && { sandbox: r.attributes.sandbox }),
    };
  }
}

/** The value as JSON reads it back: a Date as its string, undefined members gone. */
const asJson = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** True when the two are the same JSON, whatever the order of their keys. */
const sameJson = (a: unknown, b: unknown): boolean => isDeepStrictEqual(asJson(a), asJson(b));

const alreadyDecided = (runId: string, a: ApprovalState) =>
  new SanomaError("already_decided", `${a.id} on run ${runId} was already ${a.status} by ${a.decidedBy}`, {
    runId,
    approvalId: a.id,
    status: a.status,
    decidedBy: a.decidedBy,
  });
