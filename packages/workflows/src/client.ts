import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type DBOSClient, Error as DBOSErrors, type WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";
import { z } from "zod";
import { APPROVALS_EVENT, ApprovalMessage, decisionEventOf, messageKeyOf, topicOf } from "./approvals.ts";
import { beforeOf, decideCall, decideStart, recorded, startHoldOf } from "./call.ts";
import { type Chats, chatStore } from "./chats.ts";
import { collectionsDriver } from "./collection.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { deleteCredential, storeCredential, storedCredentials, storedSecrets } from "./credentials.ts";
import { dbosClient, lazyPool, type LazyPool } from "./db.ts";
import { type CredentialStatus, credentialsOf } from "./env.ts";
import { type ApprovalState, Principal, type WorkflowDefinition } from "./define.ts";
import { APPLY_WORKFLOW, type ApplyInput, type ApplyReport } from "./apply.ts";
import { DRIFT_WORKFLOW, type DriftReport } from "./drift.ts";
import { isDirect } from "./direct.ts";
import {
  ApprovalPendingError,
  type ErrorInfo,
  errorCode,
  errorInfo,
  NotAdmittedError,
  parseOrThrow,
  PolicyDeniedError,
  SanomaError,
} from "./errors.ts";
import { insertRecord, type LedgerRecord, type OwnedLedger, ownedLedger } from "./ledger.ts";
import type { CallContext, Driver, Op } from "./op.ts";
import { allowAll, type RecordedDecision } from "./policy.ts";
import { admit, readPeople } from "./resources.ts";
import type { RunArgs, StartHold } from "./run.ts";
import type { Secrets } from "./secret.ts";
import {
  BUILT_IN_WORKFLOWS,
  CALL_WORKFLOW,
  DATA_VENDOR,
  errorMessage,
  isEnded,
  isVisitor,
  refusalOf,
  type RunStatus,
  WORKFLOW_ACTION,
} from "./shared.ts";

/** A principal, or its id alone. */
const PrincipalOrId = z.union([
  z
    .string()
    .regex(/\S/)
    .transform((id) => ({ id })),
  Principal,
]);

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
  /** Only runs of the workflow of this name. */
  workflow?: string;
}

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  /** Who started the run, as `start` admitted them. */
  startedBy?: Principal;
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  error?: string;
  /** For a sandbox run, the scenario it was seeded from. */
  sandbox?: string;
}

export interface StartOptions {
  /**
   * Who starts it, by id (`"ada"`, or `{ id: "ada" }`): recorded as the run's actor in the ledger
   * and passed to the policy. When the data files declare people, the run is started as the
   * declared principal (`principalOf`: their groups, not any given here), and an id nobody
   * declares is refused with `not_admitted`.
   */
  startedBy: Principal | string;
  /**
   * Use this run id instead of a new one, so a retried start makes one run. Starting an id
   * that exists returns it, without starting another, when the workflow, the input (compared
   * as JSON), `startedBy`'s id and `sandbox` are the same, and throws `invalid_input` naming what differs
   * when they are not. Of two starts racing with one new id, the first's run stands.
   */
  runId?: string;
  /**
   * Start a sandbox run, seeded from the config's scenario of this name: it calls its own fakes,
   * made for it by its connectors' makers, instead of the drivers, and does not wait on sleeps.
   * Sandbox runs go on the app's queue like any run, so several run at once.
   */
  sandbox?: string;
}

/** What `SanomaClient.call` takes besides the operation's id and its input. */
export interface CallOptions {
  /**
   * Who calls, by id, admitted as `startedBy` is: the policy decides as them, a write's record
   * names them, and a save's `updatedBy` is their id.
   */
  actor: Principal | string;
  /**
   * The call's id, so a retried write is made once: the same id with the same input returns what
   * the first call returned, with another input is refused (`invalid_input`). A new one by default.
   */
  id?: string;
}

/** Talks to the runtime from another process (the app, a script), through the shared Postgres. */
export class SanomaClient {
  private readonly dbos: DBOSClient;
  private readonly config: ResolvedConfig;
  private readonly drivers: ReadonlyMap<string, Driver>;
  /** The config's own ledger store, or a Postgres one made for this client, which `close` then closes. */
  private readonly audit: OwnedLedger;
  /** On the config's database, for the runtime's tables (the credentials, the chats): opened on first use. */
  private readonly pool: LazyPool;
  /** What a direct call's driver reads secrets from, as a worker's live driver does. */
  private readonly storedSecrets: Secrets;
  /** The operator agent's chats: their rows and their transcripts, in the config's database. */
  readonly chats: Chats;

  private constructor(dbos: DBOSClient, config: ResolvedConfig, drivers: ReadonlyMap<string, Driver>) {
    this.dbos = dbos;
    this.config = config;
    this.drivers = drivers;
    this.audit = ownedLedger(config);
    this.pool = lazyPool(config.databaseUrl, "client");
    this.storedSecrets = storedSecrets(() => this.db(), "sanoma");
    this.chats = chatStore(() => this.db());
  }

  /**
   * Connects to the runtime's Postgres for the config's app. Checks the config first and throws
   * what the worker would refuse. Reads ledgers from the config's ledger store, or from the
   * Postgres store on its database when it has none.
   */
  static async connect(config: SanomaConfig): Promise<SanomaClient> {
    const resolved = resolveConfig(config);
    const dbos = await dbosClient(resolved.databaseUrl, resolved.appName);
    return new SanomaClient(dbos, resolved, resolved.driversByVendor);
  }

  /**
   * Checks the input against the workflow's schema, then queues a run for the worker. The run
   * gets the input as sent, not as the schema parsed it: the worker parses it once, so a schema
   * with a `.transform` or a default sees the caller's value, and `run.started` records it.
   * `workflow` is a definition, or the name of one in the config's `workflows`.
   */
  async start<S extends z.ZodType>(
    workflow: WorkflowDefinition<any, S> | string,
    input: z.input<S>,
    options: StartOptions,
  ): Promise<string> {
    const startedBy = await this.admitted(
      parseOrThrow(
        PrincipalOrId,
        options?.startedBy,
        '`startedBy` must be a principal, such as "alice" or { id: "alice" }',
      ),
    );
    if (typeof workflow === "string") {
      const named = this.config.workflows.get(workflow);
      if (!named) {
        const known = [...this.config.workflows.keys()];
        throw new SanomaError("invalid_input", `No workflow named "${workflow}"; the config has ${known.join(", ")}`, {
          workflow,
          workflows: known,
        });
      }
      workflow = named;
    }
    // The policy decides the start on the input as parsed, its defaults filled, as the Cedar schema types it.
    const parsed = parseOrThrow(workflow.input, input, `The input does not match ${workflow.name}'s schema`);
    const { runId } = options;
    const sandbox = parseOrThrow(
      z.string().min(1).optional(),
      options.sandbox,
      "`sandbox` must be the name of a scenario in the config's `scenarios/`",
    );
    const hold = await this.startHold(workflow.name, parsed, startedBy, runId);
    const args: RunArgs = { input, startedBy, ...(sandbox === undefined ? {} : { sandbox }), ...(hold && { hold }) };
    const { onBehalfOf } = startedBy;
    // An id DBOS has already returns that run, unless it is another workflow's, which DBOS refuses.
    const handle = await this.dbos
      .enqueue(
        {
          queueName: this.config.queueName,
          workflowName: workflow.name,
          workflowID: runId,
          applicationName: this.config.appName,
          authenticatedUser: startedBy.id,
          authenticatedRoles: startedBy.groups ?? [],
          // Kept on the run's status row too, so a listing tells sandbox runs apart without its input,
          // and says whom an agent's run is for (DBOS keeps the principal's id and groups itself).
          ...((sandbox !== undefined || onBehalfOf !== undefined) && { attributes: { sandbox, onBehalfOf } }),
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

  /**
   * The policy's answer to starting a run of `workflow` as `startedBy` (`decideStart`), for a
   * workflow of the config's own: a deny throws `policy_denied`; a hold is what the run waits on
   * before its body. A run `runId` names already is returned as it is, whatever the policy says now, but to a visitor.
   * A visitor (`isVisitor`) starts no built-in but `call`, whose calls the policy decides as direct ones.
   */
  private async startHold(
    workflow: string,
    input: unknown,
    startedBy: Principal,
    runId: string | undefined,
  ): Promise<StartHold | undefined> {
    const { policy } = this.config;
    const visitor = isVisitor(startedBy);
    const builtIn = BUILT_IN_WORKFLOWS.has(workflow);
    if (visitor && builtIn && workflow !== CALL_WORKFLOW) {
      throw new PolicyDeniedError(
        `${WORKFLOW_ACTION}${workflow}`,
        "A visitor may not start the runtime's own workflows",
      );
    }
    if (builtIn || (policy === allowAll && !visitor)) return undefined;
    // A visitor's start is decided whatever run its id names: a visitor shares an id (`anonymous`) with others.
    if (!visitor && runId !== undefined && (await this.row(runId))) return undefined;
    const decision = decideStart(policy, workflow, input, startedBy);
    if (decision.kind === "allow") return undefined;
    if (decision.kind === "deny") throw new PolicyDeniedError(`${WORKFLOW_ACTION}${workflow}`, decision.reason);
    return startHoldOf(workflow, decision);
  }

  /**
   * Calls an operation directly, outside a run, as `actor`: one that may be (`isDirect`), a
   * collection's or a vendor's read, never a vendor's write, the runtime's own or a resource
   * type's (`invalid_input`, as is an unknown id or input its schema refuses). The policy decides
   * it as the person, in a run `direct:<actor>:<id>` of the workflow `call` with no approvals. A
   * deny throws `policy_denied` and writes nothing. An allowed call runs the driver once, without
   * DBOS and without a retry (a driver's failure is `driver_failed`). A read returns its output
   * and records nothing. A write is recorded as one `op.called` (seq 0) in that run, and with the
   * default ledger in one transaction with the record it saves, so both are written or neither;
   * a write with the same id and input returns the output recorded. When the policy asks for an
   * approval, the call becomes run `call:<actor>:<id>` of the built-in `call` workflow, started
   * as the person, which makes it once approved, and this throws `approval_pending` with its id.
   */
  async call(opId: string, input: unknown, options: CallOptions): Promise<unknown> {
    const actor = await this.admitted(
      parseOrThrow(PrincipalOrId, options?.actor, '`actor` must be a principal, such as "alice" or { id: "alice" }'),
    );
    const id =
      parseOrThrow(z.string().min(1).optional(), options.id, "`id` must be a non-empty string") ?? randomUUID();
    const { ops, types, drivers, policy } = this.config;
    const op = ops.get(opId);
    if (!op || !isDirect(op, types)) {
      const why = op ? "it is a workflow's to call: start one that uses it" : "no connector or collection declares it";
      throw new SanomaError("invalid_input", `${opId} cannot be called directly: ${why}`, { op: opId });
    }
    const fn = drivers.get(op.id);
    if (!fn) throw new SanomaError("invalid_input", `${op.id} has no driver: the connector package must attach one`);
    const parsed = parseOrThrow(op.input, input, `The input to ${op.id} does not match its schema`, { op: op.id });
    const runId = `direct:${actor.id}:${id}`;
    const heldId = `call:${actor.id}:${id}`;
    const held: RunArgs = { input: { op: op.id, input }, startedBy: actor };
    const logged = recorded(op, parsed);
    const write = op.effect !== "read";
    // Only an id the caller gave can have been used: a write made, or held, with it settles it.
    if (write && options.id !== undefined) {
      const first = (await this.recordedCall(runId, op.id, logged)) ?? (await this.heldCall(op.id, heldId, held));
      if (first) return first.output;
    }
    const before = await beforeOf(policy, op, parsed, this.config.collections, (get, key) =>
      drivers.get(get)?.(
        { key },
        { idempotencyKey: `${runId}:before`, runId, opId: get, attempt: 1, secrets: this.storedSecrets, by: actor.id },
      ),
    );
    const run = { id: runId, workflow: CALL_WORKFLOW, approvals: [] };
    const decision = decideCall(policy, op, parsed, actor, run, before);
    if (decision.kind === "deny") throw new PolicyDeniedError(op.id, decision.reason);
    if (decision.kind === "approve") {
      await this.start(CALL_WORKFLOW, held.input, { startedBy: actor, runId: heldId });
      // A read held before, whose run has ended since, answers with that run's result.
      return (await this.heldCall(op.id, heldId, held))!.output;
    }
    const context: CallContext = {
      idempotencyKey: runId,
      runId,
      opId: op.id,
      attempt: 1,
      secrets: this.storedSecrets,
      by: actor.id,
    };
    if (!write) return outputOf(op, () => fn(parsed, context));
    return this.directWrite({ op, fn, parsed, logged, actor, decision, context });
  }

  /**
   * A direct write, made once and recorded once: with the default ledger, a collection's write
   * and its record in one transaction on the database both are in, so both are kept or neither;
   * otherwise the driver's call, then the record in the config's ledger. The first record of the
   * call's id stands: a write that finds one already there (two calls with one id at once) is
   * undone, and answers as `recordedCall` does.
   */
  private async directWrite(call: {
    op: Op;
    fn: (input: unknown, context: CallContext) => Promise<unknown>;
    parsed: unknown;
    logged: unknown;
    actor: Principal;
    decision: RecordedDecision;
    context: CallContext;
  }): Promise<unknown> {
    const { op, parsed, logged, actor, decision, context } = call;
    const { runId } = context;
    const { dataStore, collections, ledger } = this.config;
    const conn = op.vendor === DATA_VENDOR && !ledger && dataStore ? await (await dataStore.db()).connect() : undefined;
    let broken: Error | undefined;
    try {
      await conn?.query("BEGIN");
      // On the transaction's connection, the collection's own driver: it has no `env` to guard.
      const fn = conn
        ? collectionsDriver([collections.get(op.resource)!], { db: async () => conn }).ops[`${op.resource}.${op.name}`]!
        : call.fn;
      const at = Date.now();
      const record = (outcome: { output: unknown } | { error: ErrorInfo }): LedgerRecord => ({
        v: 1,
        app: this.config.appName,
        id: `${runId}:op.called:0`,
        runId,
        seq: 0,
        at,
        actor,
        workflow: CALL_WORKFLOW,
        type: "op.called",
        op: op.id,
        effect: op.effect,
        input: logged,
        decision,
        ...outcome,
        durationMs: Date.now() - at,
      });
      let output: unknown;
      try {
        output = await outputOf(op, () => fn(parsed, context));
      } catch (err) {
        // Recorded on the store's own connection; the transaction is rolled back below.
        await this.audit.store.append(record({ error: errorInfo(err) }));
        throw err;
      }
      const done = record({ output: recorded(op, output) });
      if (!conn) {
        await this.audit.store.append(done);
        return output;
      }
      if (await insertRecord(conn, done)) {
        await conn.query("COMMIT");
        return output;
      }
      await conn.query("ROLLBACK");
      return (await this.recordedCall(runId, op.id, logged))!.output;
    } catch (err) {
      await conn?.query("ROLLBACK").catch((e: Error) => (broken = e));
      throw err;
    } finally {
      conn?.release(broken);
    }
  }

  /**
   * What the direct write recorded as `runId` returned, when one did: refused (`invalid_input`)
   * when it was of another operation or input, and its failure again (`driver_failed`) when it failed.
   */
  private async recordedCall(runId: string, opId: string, input: unknown): Promise<{ output: unknown } | undefined> {
    const first = (await this.audit.store.read(runId)).find((r) => r.type === "op.called");
    if (!first) return undefined;
    const differs = [...(first.op === opId ? [] : ["op"]), ...(sameJson(first.input, input) ? [] : ["input"])];
    if (differs.length) {
      throw new SanomaError(
        "invalid_input",
        `Call ${runId} was made already with a different ${differs.join(" and ")}; use another id`,
        { runId, differs },
      );
    }
    if (first.error) {
      throw new SanomaError(
        "driver_failed",
        `${opId} failed when first called as ${runId}: ${first.error.message}; call again with another id`,
        {
          runId,
          op: opId,
          error: first.error,
        },
      );
    }
    return { output: first.output };
  }

  /**
   * What the held call's run `heldId` returned once it ended (its error, when it failed);
   * `approval_pending` while it has not; undefined when there is no such run. Refused
   * (`invalid_input`) when the run was started with another input or by someone else.
   */
  private async heldCall(opId: string, heldId: string, args: RunArgs): Promise<{ output: unknown } | undefined> {
    const [row] = await this.dbos.listWorkflows({ workflowIDs: [heldId], loadInput: false, loadOutput: false });
    if (!row) return undefined;
    await this.mustMatch(heldId, args);
    if (!isEnded(runStatus(row.status, []))) throw new ApprovalPendingError(opId, heldId);
    return { output: await this.awaitResult(heldId, 30_000) };
  }

  /**
   * The newest finished run of the workflow, with its output and when it finished; null when it
   * has none. One query, whatever the app's runs.
   */
  async latest(workflow: string): Promise<{ runId: string; output: unknown; at: number } | null> {
    const [row] = await this.dbos.listWorkflows({
      workflowName: workflow,
      applicationName: this.config.appName,
      status: "SUCCESS",
      sortDesc: true,
      limit: 1,
      loadInput: false,
      loadOutput: true,
    });
    return row ? { runId: row.workflowID, output: row.output, at: row.updatedAt ?? row.createdAt } : null;
  }

  /** The run's audit record, in order, from the ledger store. */
  async ledger(runId: string): Promise<LedgerRecord[]> {
    await this.mustExist(runId);
    return this.audit.store.read(runId);
  }

  /**
   * The app's runs, newest first: the latest `limit`, or the latest `limit` with a `status`.
   * Only the approvals tell `running` from `waiting`, so those read PENDING runs a page at a
   * time until `limit` have that status.
   */
  async runs({ limit = 20, status, workflow }: RunsFilter = {}): Promise<RunSummary[]> {
    const list = (more: { limit: number; offset?: number }) =>
      this.dbos.listWorkflows({
        ...more,
        status: status && dbosStatusesOf(status),
        workflowName: workflow,
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
    const given = parseOrThrow(ApprovalMessage, message, "Not a decision");
    const declared = readPeople(this.config.root);
    const msg = { ...given, by: admit(given.by, declared) };
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
    const reason = refusalOf(
      target,
      msg.by,
      { actor: row.authenticatedUser ? { id: row.authenticatedUser } : undefined },
      declared.people,
    );
    if (reason !== undefined) {
      throw new SanomaError("not_approver", `${reason} (${target.id})`, {
        runId,
        approvalId: target.id,
        approver: target.approver,
        reason,
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
        reason: refused.reason,
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
    return this.awaitResult(runId, timeoutMs);
  }

  /**
   * Starts the built-in drift workflow, which reads the config's data files itself: `start`
   * with its input, `{}`. Returns the run id; `driftReport` waits for its report. Throws
   * `invalid_input` when the config's connectors declare no resource types, so it has none.
   */
  async drift(options: StartOptions): Promise<string> {
    return this.start(this.builtIn(DRIFT_WORKFLOW), {}, options);
  }

  /** The report of a drift run once it ends: as `applyReport` for apply. */
  async driftReport(runId: string): Promise<DriftReport> {
    return (await this.reportOf(runId, DRIFT_WORKFLOW)) as DriftReport;
  }

  /**
   * Starts the built-in apply workflow, which reads the config's data files itself, with `input`
   * (`only`, `bind`, `answers`; `{}` for all). Returns the run id; `applyReport` waits for its
   * report. Throws `invalid_input` when the config's connectors declare no resource types.
   */
  async apply(input: ApplyInput, options: StartOptions): Promise<string> {
    return this.start(this.builtIn(APPLY_WORKFLOW), input, options);
  }

  /**
   * The report of an apply run once it ends. Throws `run_not_found`, `invalid_input` for another
   * workflow's run, the run's error when it failed, and `run_running` when it has not ended
   * within 30 s.
   */
  async applyReport(runId: string): Promise<ApplyReport> {
    return (await this.reportOf(runId, APPLY_WORKFLOW)) as ApplyReport;
  }

  /** The built-in workflow `name`; `invalid_input` when the config has none, as its connectors declare no resource types. */
  private builtIn(name: string) {
    const workflow = this.config.workflows.get(name);
    if (!workflow) {
      throw new SanomaError(
        "invalid_input",
        `The config's connectors declare no resource types, so it has no built-in ${name} workflow`,
      );
    }
    return workflow;
  }

  /** The output of a run of the built-in `workflow` once it ends. */
  private async reportOf(runId: string, workflow: string): Promise<unknown> {
    const row = await this.mustExist(runId, { loadOutput: true });
    if (row.workflowName !== workflow) {
      throw new SanomaError("invalid_input", `Run ${runId} is a run of ${row.workflowName}, not of ${workflow}`, {
        runId,
        workflow: row.workflowName,
      });
    }
    // A finished run's report came with its row; else wait for the run.
    return row.status === "SUCCESS" ? row.output : await this.awaitResult(runId, 30_000);
  }

  /**
   * Stores a value for a variable a driver's `env` declares, as `by`, and tells the workers: each
   * loads it into its environment, unless its environment sets the variable itself. Refuses
   * (`invalid_input`) a name no driver declares, and a value the variable's schema refuses, with
   * the schema's reason and never the value; an empty value too (`clearCredential` unsets one).
   * Nothing records the value but its row, which records `by` and when. `by` is admitted as
   * `start`'s `startedBy` is (`not_admitted`).
   */
  async setCredential(name: string, value: string, options: { by: string }): Promise<void> {
    const setBy = await this.admittedBy(options);
    // Checked against every declaration of the name, as the worker checks it.
    const statuses = this.declared(name, (n) => (n === name ? value : undefined));
    const refused = statuses.find((c) => c.status !== "set");
    if (refused) {
      const problem = refused.problem ?? "it is empty; clear it to unset it";
      throw new SanomaError("invalid_input", `${name} cannot be set: ${problem}`, {
        name,
        issues: [{ path: ["value"], message: problem, code: "custom" }],
      });
    }
    await storeCredential(await this.db(), { name, value, setBy });
  }

  /**
   * Deletes the stored value of a declared variable, and tells the workers, which unset it unless
   * their environment sets it. `by` is who asks; nothing records it once the row is gone.
   * Refuses (`invalid_input`) a name no driver declares, and `by` as `setCredential` does.
   */
  async clearCredential(name: string, options: { by: string }): Promise<void> {
    await this.admittedBy(options);
    this.declared(name, () => undefined);
    await deleteCredential(await this.db(), name);
  }

  /**
   * Stores a secret as `by`, and tells the workers: a value under any variable's name, declared by
   * a driver or not, such as a data file's `secret("NAME")` or the app's own (its GitHub App's
   * keys). A name a driver declares is checked as `setCredential` checks it; any other name must
   * look like a variable's, and the value must not be empty (`invalid_input`, never the value).
   */
  async setSecret(name: string, value: string, options: { by: string }): Promise<void> {
    if ([...credentialsOf(this.drivers, () => undefined).values()].flat().some((c) => c.name === name)) {
      return this.setCredential(name, value, options);
    }
    const setBy = await this.admittedBy(options);
    const problem = !VARIABLE.test(name) ? "That is not a variable name" : !value ? "Enter a value" : undefined;
    if (problem) {
      const path = VARIABLE.test(name) ? "value" : "name";
      throw new SanomaError("invalid_input", problem, { issues: [{ path: [path], message: problem, code: "custom" }] });
    }
    await storeCredential(await this.db(), { name, value, setBy });
  }

  /**
   * The values of these secrets, as a driver's `secrets.get` reads them: this process's
   * environment, which wins, else the stored value, with who set it and when. A name with neither
   * is left out. For server code: a page is told whether one is set, never its value.
   */
  async secrets(names: readonly string[]): Promise<Map<string, StoredSecret>> {
    const rows = await storedCredentials(await this.db(), names);
    const found = new Map<string, StoredSecret>();
    for (const name of names) {
      const env = process.env[name];
      const row = rows.get(name);
      if (env && env !== row?.value) found.set(name, { value: env, source: "environment" });
      else if (row) found.set(name, { ...row, source: "stored" });
    }
    return found;
  }

  /**
   * Each vendor's declared variables and their statuses now: from this process's environment,
   * which wins, else from the stored credentials, with `source` saying which (a value equal to
   * the stored one, as a worker in this process loads it, is `stored`), and who set a stored one
   * and when. Never a value.
   */
  async credentials(): Promise<Map<string, CredentialStatus[]>> {
    const names = [...credentialsOf(this.drivers, () => undefined).values()].flat().map((c) => c.name);
    if (!names.length) return new Map();
    const rows = await storedCredentials(await this.db(), names);
    const statuses = credentialsOf(this.drivers, (name) => process.env[name] || rows.get(name)?.value);
    const sourced = (c: CredentialStatus): CredentialStatus => {
      const row = rows.get(c.name);
      const env = process.env[c.name];
      // A worker in this process loads the stored values into its environment: those are stored.
      if (env && env !== row?.value) return { ...c, source: "environment" };
      return row ? { ...c, source: "stored", setBy: row.setBy, setAt: row.setAt } : c;
    };
    return new Map([...statuses].map(([vendor, list]) => [vendor, list.map(sourced)]));
  }

  async close() {
    await Promise.all([this.dbos.destroy(), this.pool.close(), this.audit.close(), this.config.dataStore?.close()]);
  }

  /**
   * The name's statuses with `lookup`'s value, one per vendor whose drivers declare it, or
   * `invalid_input` when none does.
   */
  private declared(name: string, lookup: (name: string) => string | undefined): CredentialStatus[] {
    const all = [...credentialsOf(this.drivers, lookup).values()].flat();
    const statuses = all.filter((c) => c.name === name);
    if (statuses.length) return statuses;
    const known = [...new Set(all.map((c) => c.name))];
    // A name that is no variable's may be a value sent in its place: it is not repeated.
    const named = VARIABLE.test(name);
    const message = `${named ? `No driver declares ${name}` : "That is not a variable name"}; ${
      known.length ? `the declared variables are ${known.join(", ")}` : "none declares any"
    }`;
    throw new SanomaError("invalid_input", message, {
      ...(named && { name }),
      issues: [{ path: ["name"], message, code: "custom" }],
    });
  }

  /** The pool the runtime's tables are read and written with, on the database once it is prepared. */
  private db(): Promise<Pool> {
    return this.pool.db();
  }

  /**
   * The principal as the data files declare it (`admit`): its id alone is taken, never the groups
   * a caller gives, and an id nobody declares is `not_admitted`.
   */
  private async admitted(principal: Principal): Promise<Principal> {
    return admit(principal, readPeople(this.config.root));
  }

  /** `options.by`, who sets or clears a credential, admitted (`admitted`): their id; never a visitor's. */
  private async admittedBy(options: { by: string }): Promise<string> {
    const by = parseOrThrow(z.string().min(1), options?.by, '`by` must name who is asking, such as "alice"');
    if (isVisitor({ id: by })) throw new NotAdmittedError(by);
    return (await this.admitted({ id: by })).id;
  }

  /** Refuses a run id whose run, as stored, was started with another input, by someone else, or in another sandbox. */
  private async mustMatch(runId: string, args: RunArgs) {
    const [stored] = ((await this.dbos.getWorkflow(runId))?.input ?? []) as [RunArgs?];
    // Who started it by id alone: their groups are the people files' at the time, which may change.
    const differs = (["input", "startedBy", "sandbox"] as const).filter(
      (key) =>
        !stored ||
        (key === "startedBy" ? stored.startedBy?.id !== args.startedBy.id : !sameJson(stored[key], args[key])),
    );
    if (differs.length) {
      throw new SanomaError(
        "invalid_input",
        `Run ${runId} already exists with a different ${differs.join(", ")}; use another run id`,
        { runId, differs },
      );
    }
  }

  /** The run's status row, read without its input (and its output, unless asked), if there is one. */
  private async row(runId: string, { loadOutput = false } = {}) {
    const [row] = await this.dbos.listWorkflows({ workflowIDs: [runId], loadInput: false, loadOutput });
    return row;
  }

  /** The run's status row, as `row` reads it, or `run_not_found`. */
  private async mustExist(runId: string, options: { loadOutput?: boolean } = {}) {
    const row = await this.row(runId, options);
    if (!row) throw new SanomaError("run_not_found", `No run ${runId}`, { runId });
    return row;
  }

  /** The run's output once it ends, or its error, polled every 100 ms; `run_running` after `timeoutMs`. */
  private async awaitResult(runId: string, timeoutMs: number): Promise<unknown> {
    const running = () =>
      new SanomaError("run_running", `Run ${runId} is still running after ${timeoutMs} ms`, { runId, timeoutMs });
    let timer: NodeJS.Timeout | undefined;
    try {
      // DBOSClient's wait takes no timeout of its own.
      return await Promise.race([
        this.dbos.retrieveWorkflow(runId).getResult({ pollingIntervalMs: 100 }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(running()), timeoutMs).unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
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
    const onBehalfOf = r.attributes?.onBehalfOf;
    return {
      runId: r.workflowID,
      workflow: r.workflowName,
      status: runStatus(r.status, approvals),
      startedBy: r.authenticatedUser
        ? {
            id: r.authenticatedUser,
            ...(groups.length ? { groups } : {}),
            ...(typeof onBehalfOf === "string" && { onBehalfOf }),
          }
        : undefined,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvals,
      error: r.error ? String((r.error as Error).message ?? r.error) : undefined,
      ...(typeof r.attributes?.sandbox === "string" && { sandbox: r.attributes.sandbox }),
    };
  }
}

/**
 * What a direct call's driver returned, as the operation's output schema parses it; a failure
 * with none of the runtime's codes (a reply the schema refuses, an error the driver let escape)
 * is `driver_failed`, naming the operation.
 */
async function outputOf(op: Op, call: () => Promise<unknown>): Promise<unknown> {
  try {
    return op.output.parse(await call());
  } catch (err) {
    if (errorCode(err) !== undefined) throw err;
    throw new SanomaError("driver_failed", `${op.id} failed: ${errorMessage(err)}`, { op: op.id }, { cause: err });
  }
}

/** The value as JSON reads it back: a Date as its string, undefined members gone. */
const asJson = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** True when the two are the same JSON, whatever the order of their keys. */
const sameJson = (a: unknown, b: unknown): boolean => isDeepStrictEqual(asJson(a), asJson(b));

/** A secret's value as `SanomaClient.secrets` reads it, and where from. */
export interface StoredSecret {
  value: string;
  source: "environment" | "stored";
  /** Who stored it (`setSecret`'s `by`), and when, as an ISO 8601 time. */
  setBy?: string;
  setAt?: string;
}

/** What an environment variable's name looks like. */
const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;

const alreadyDecided = (runId: string, a: ApprovalState) =>
  new SanomaError("already_decided", `${a.id} on run ${runId} was already ${a.status} by ${a.decidedBy}`, {
    runId,
    approvalId: a.id,
    status: a.status,
    decidedBy: a.decidedBy,
  });
