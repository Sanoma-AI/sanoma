import type { Pool } from "pg";
import {
  connectionDriver,
  connectionTargetSchema,
  type ConnectionRef,
  type ConnectionSnapshot,
  type ConnectionTarget,
  type ConnectionSetup,
  type ConnectionCard,
  type ConnectionRule,
} from "./connection.ts";
import { encodeCredentials, decodeCredentials, verifyAuthentication, AuthenticationError } from "./authentication.ts";
import { type AttemptStatus, connectRunId, oauthApplication, type OAuthClient, oauthClient } from "./oauth.ts";

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type DBOSClient, Error as DBOSErrors, type WorkflowStatusString } from "@dbos-inc/dbos-sdk";
import { is } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { z } from "zod";
import {
  APPROVALS_EVENT,
  ApprovalMessage,
  ApprovalWithdrawal,
  decisionEventOf,
  messageKeyOf,
  topicOf,
  withdrawalRefusal,
} from "./approvals.ts";
import {
  beforeOf,
  type Call,
  callsOf,
  decideCall,
  decideStart,
  decisionOf,
  deniedKeys,
  outputsOf,
  recorded,
  startHoldOf,
  targetOf,
} from "./call.ts";
import { type Chats, chatStore } from "./chats.ts";
import { type Tokens, tokenStore } from "./tokens.ts";
import { collectionsDriver } from "./collection.ts";
import { type ResolvedConfig, resolveConfig, type SanomaConfig } from "./config.ts";
import { configuredSecrets } from "./credentials.ts";
import { readStoreMoves, type StoreMove } from "./store-move.ts";
import {
  type AppBehind,
  dbosClient,
  lazyDb,
  type LazyDb,
  readAppBehind,
  readRunChecks,
  spendInviteRequest,
} from "./db.ts";
import { type CredentialStatus, credentialsOf } from "./env.ts";
import { type ApprovalState, Principal, type WorkflowDefinition } from "./define.ts";
import { APPLY_WORKFLOW, type ApplyInput, type ApplyReport } from "./apply.ts";
import {
  ADMIN,
  type ChangeEvent,
  ChangeEventSchema,
  ChangeInput,
  type ChangeReport,
  type ChangeState,
  initialChangeState,
} from "./change.ts";
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
import {
  insertRecord,
  lastInvite,
  lastSignIns,
  type LedgerRecord,
  loginRecord,
  type OwnedLedger,
  ownedLedger,
} from "./ledger.ts";
import type { CallContext, Driver, Op, SignInMethod } from "./op.ts";
import { allowAll, type RecordedDecision } from "./policy.ts";
import { admit, readPeople } from "./resources.ts";
import type { RunArgs, StartHold } from "./run.ts";
import { SecretStoreError, type SecretAccess, type SecretLocation } from "./secret-store.ts";
import {
  BUILT_IN_WORKFLOWS,
  CALL_WORKFLOW,
  CHANGE_EVENT,
  CHANGE_MERGE,
  CHANGE_TOPIC,
  CHANGE_WORKFLOW,
  CHAT_TOPIC,
  CHAT_WORKFLOW,
  CONNECT_WORKFLOW,
  connectionCallbackPath,
  changeIdOf,
  chatRunId,
  chatRunPrefix,
  DATA_VENDOR,
  DRAFT_ID,
  ENDED_STATUSES,
  errorMessage,
  FOLLOW_WORKFLOW,
  HOST_CHECK_AGENT,
  isBatch,
  isEnded,
  isToken,
  isVisitor,
  LIST_LIMIT,
  refusalOf,
  type RunStatus,
  SAVE_DRAFT_WORKFLOW,
  saveIdOf,
  SCHEDULE_AGENT,
  WORKFLOW_ACTION,
} from "./shared.ts";
import { RemoteEventSchema } from "./follow-workflow.ts";
import { SaveDraftInput, type SaveDraftOutput } from "./app-workflows.ts";
import type { ChatTell, ChatTurnInput } from "./chat-workflow.ts";
import { sealChatCode } from "./seal.ts";
import type { RunChecks } from "./scenario.ts";
import type { RemoteEvent } from "./source.ts";

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

/** A change as the app shows it: its run, where the change is (`ChangeState`), and how it ended. */
export interface ChangeView {
  runId: string;
  status: RunStatus;
  startedBy?: Principal;
  /** When the run started, and when its row last changed (epoch ms), as `RunSummary` has them. */
  createdAt: number;
  updatedAt?: number;
  approvals: ApprovalState[];
  /** What the run last published (`CHANGE_EVENT`); `opening`, with no branch yet, before it has. */
  state: ChangeState;
  /** The run's output, once it has finished. */
  report?: ChangeReport;
}

/** A save of a draft as the app shows it (`SanomaClient.saves`): its run, its input, and once finished its output. */
export interface SaveView extends RunSummary {
  input: SaveDraftInput;
  output?: SaveDraftOutput;
}

/** Which changes `SanomaClient.changes` lists: `open` (not ended) or not, and at most `limit` (20), newest first. */
export interface ChangesFilter {
  open?: boolean;
  limit?: number;
}

/** What `SanomaClient.call` takes besides the operation's id and its input. */
export interface CallOptions {
  connection?: ConnectionRef;
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

/** A credential-free review shown before the user saves a connection. */
export interface ConnectionReview extends ConnectionSetup {
  authorization: string;
  requestId: string;
  account: string;
  scopes: string[];
  credentialVersion: string | null;
  expiresAt?: number;
}
/** What `SanomaClient.connect` is given besides the config. */
export interface ClientOptions {
  /**
   * Called, never awaited, right before each change a worker must run: a run's start (drift,
   * apply and a held call are starts) and an approval's decision or withdrawal; never for a read. A process that
   * runs a worker that stops when idle starts it again with it (`Supervisor.resume`). Must not throw.
   */
  onWrite?: () => void;
  /**
   * The version each run it starts is queued for, so only a worker of that code runs it: the app
   * bundle's (its snapshot's), which is live beside a worker of another version while a deploy
   * rolls. Without it a run is queued with none, which DBOS gives the app's latest version.
   */
  appVersion?: string;
}

/** Talks to the runtime from another process (the app, a script), through the shared Postgres. */

/** The direct connection ops that call the provider, so never in a transaction (`sanoma.connection.*`). */
const PROVIDER_CALLS: ReadonlySet<string> = new Set([
  "sanoma.connection.test",
  "sanoma.connection.refresh",
  "sanoma.connection.revoke",
]);
export class SanomaClient {
  private readonly dbos: DBOSClient;
  private readonly config: ResolvedConfig;
  private readonly drivers: ReadonlyMap<string, Driver>;
  /** The config's own ledger store, or a Postgres one made for this client, which `close` then closes. */
  private readonly audit: OwnedLedger;
  /** On the config's database, for the runtime's tables (the credentials, the chats): opened on first use. */
  private readonly database: LazyDb;
  /** What a direct call's driver reads secrets from, as a worker's live driver does. */
  private readonly storedSecrets: SecretAccess;
  /** The operator agent's chats: their rows and their transcripts, in the config's database. */
  readonly chats: Chats;
  /** The api tokens a public site's api takes as a bearer (`token:<id>`, a visitor): minted, revoked, resolved. */
  readonly tokens: Tokens;
  private readonly options: ClientOptions;

  private constructor(
    dbos: DBOSClient,
    config: ResolvedConfig,
    drivers: ReadonlyMap<string, Driver>,
    options: ClientOptions,
  ) {
    this.dbos = dbos;
    this.config = config;
    this.drivers = drivers;
    this.options = options;
    this.audit = ownedLedger(config);
    this.database = lazyDb(config.databaseUrl, "client");
    this.storedSecrets = configuredSecrets(config.secrets, () => this.database.db());
    this.chats = chatStore(() => this.database.db());
    this.tokens = tokenStore(() => this.database.db());
  }

  /**
   * Connects to the runtime's Postgres for the config's app. Checks the config first and throws
   * what the worker would refuse. Reads ledgers from the config's ledger store, or from the
   * Postgres store on its database when it has none.
   */
  static async connect(config: SanomaConfig, options: ClientOptions = {}): Promise<SanomaClient> {
    const resolved = resolveConfig(config);
    const dbos = await dbosClient(resolved.databaseUrl, resolved.appName);
    const client = new SanomaClient(dbos, resolved, resolved.driversByVendor, options);
    try {
      await client.storedSecrets.validate();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /**
   * Checks the input against the workflow's schema, then queues a run for the worker. The run
   * gets the input as sent, not as the schema parsed it: the worker parses it once, so a schema
   * with a `.transform` or a default sees the caller's value, and `run.started` records it.
   * `workflow` is a definition, or the name of one in the config's `workflows`. The run is queued
   * for the client's `appVersion` when it has one.
   */
  async start<S extends z.ZodType>(
    workflow: WorkflowDefinition<any, S> | string,
    input: z.input<S>,
    options: StartOptions,
  ): Promise<string> {
    const startedBy = await this.withSubject(
      await this.admitted(
        parseOrThrow(
          PrincipalOrId,
          options?.startedBy,
          '`startedBy` must be a principal, such as "alice" or { id: "alice" }',
        ),
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
    const own = OWN_STARTS[workflow.name];
    if (own && !(await own.admits(parsed, startedBy, runId, this))) {
      const refused = `A run of ${workflow.name} is started with ${own.by}, which names its run`;
      throw new SanomaError("invalid_input", refused, { runId });
    }
    const args: RunArgs = { input, startedBy, ...(sandbox === undefined ? {} : { sandbox }), ...(hold && { hold }) };
    // Kept on the run's status row too, so a listing tells sandbox runs apart without its input,
    // and says whom an agent's run is for (DBOS keeps the principal's id and groups itself); a
    // built-in run's code, so a worker on another version with the same takes it over.
    const attributes = {
      sandbox,
      onBehalfOf: startedBy.onBehalfOf,
      builtInCode: this.config.builtInCodes[workflow.name],
    };
    this.options.onWrite?.();
    // An id DBOS has already returns that run, unless it is another workflow's, which DBOS refuses.
    const handle = await this.dbos
      .enqueue(
        {
          queueName: this.config.queueName,
          workflowName: workflow.name,
          workflowID: runId,
          applicationName: this.config.appName,
          ...(this.options.appVersion !== undefined && { appVersion: this.options.appVersion }),
          authenticatedUser: startedBy.id,
          authenticatedRoles: startedBy.groups ?? [],
          ...(Object.values(attributes).some((v) => v !== undefined) && { attributes }),
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
   * A visitor (`isVisitor`, an api token's principal too) starts no built-in but `call`, whose calls
   * the policy decides as direct ones: the app's own actions on the repository (`app-workflows.ts`)
   * are staff's, as their server functions were, which no site's host answered.
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
   * and records nothing. A write is recorded as one `op.called` per call it makes (`callsOf`, seq
   * from 0) in that run, and with the default ledger in one transaction with what it saves, so
   * both are written or neither;
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
    const connection = await this.config.connections.select(op.vendor, options.connection, actor.id);
    const selected = connection && {
      $connection: connection.id,
      vendor: connection.vendor,
      revision: connection.revision,
    };
    const runId = `direct:${actor.id}:${id}`;
    const heldId = `call:${actor.id}:${id}`;
    const held: RunArgs = { input: { op: op.id, input, ...(selected && { connection: selected }) }, startedBy: actor };
    // The calls this one makes (a batch's entries), each decided and recorded on its own.
    const calls = callsOf(op, parsed, ops);
    const write = op.effect !== "read";
    // Only an id the caller gave can have been used: a write made, or held, with it settles it.
    // One made and partly recorded is made again, as a retry (the store keeps the records it has).
    let attempt = 1;
    if (write && options.id !== undefined) {
      const made = await this.recordedCall(runId, op, calls, connection);
      if (made && "partial" in made) attempt = 2;
      else {
        const first = made ?? (await this.heldCall(op.id, heldId, held));
        if (first) return first.output;
      }
    }
    const run = { id: runId, workflow: CALL_WORKFLOW, approvals: [] };
    const decisions: RecordedDecision[] = [];
    for (const [i, c] of calls.entries()) {
      const before = await beforeOf(policy, c.op, c.input, this.config.collections, (get, key) =>
        drivers.get(get)?.(
          { key },
          {
            idempotencyKey: `${runId}:before${i ? `:${i}` : ""}`,
            runId,
            opId: get,
            attempt: 1,
            secrets: this.storedSecrets,
            by: actor.id,
          },
        ),
      );
      decisions.push(decideCall(policy, c.op, c.input, actor, run, { ...before, ...(connection && { connection }) }));
    }
    const decision = decisionOf(op, calls, decisions, this.config.collections);
    if (decision.kind === "deny") {
      throw new PolicyDeniedError(op.id, decision.reason, deniedKeys(op, calls, decisions, this.config.collections));
    }
    if (decision.kind === "approve") {
      await this.start(CALL_WORKFLOW, held.input, { startedBy: actor, runId: heldId });
      // A read held before, whose run has ended since, answers with that run's result.
      return (await this.heldCall(op.id, heldId, held))!.output;
    }
    const context: CallContext = {
      idempotencyKey: runId,
      runId,
      opId: op.id,
      attempt,
      secrets: this.storedSecrets,
      by: actor.id,
      principal: actor,
      ...(connection && { connection }),
    };
    await this.config.connections.assertCurrent(connection, actor.id);
    if (!write) return outputOf(op, () => fn(parsed, context));
    return this.directWrite({ op, fn, parsed, calls, actor, decisions, context });
  }

  /**
   * A direct write, made once and recorded once: with the default ledger, a collection's write
   * and its records in one transaction on the database both are in, so both are kept or neither;
   * otherwise the driver's call, then the records in the config's ledger. A write is recorded as
   * one `op.called` per call it makes (`callsOf`: one, or a batch's entries), numbered from 0.
   * The first records of the call's id stand: a write that finds one already there (two calls
   * with one id at once) is undone, and answers as `recordedCall` does.
   */
  private async directWrite(call: {
    op: Op;
    fn: (input: unknown, context: CallContext) => Promise<unknown>;
    parsed: unknown;
    calls: readonly Call[];
    actor: Principal;
    decisions: readonly RecordedDecision[];
    context: CallContext;
  }): Promise<unknown> {
    const { op, parsed, calls, actor, decisions, context } = call;
    const { runId } = context;
    const { dataStore, collections, ledger } = this.config;
    // A connection op that calls the provider (Test's verify, a renewal, a revocation; each may wait
    // on a renewal lease too) runs outside a transaction: one held idle that long Postgres ends.
    const connectionMutation = op.id.startsWith("sanoma.connection.") && !PROVIDER_CALLS.has(op.id);
    const transactionStore = connectionMutation
      ? this.config.connectionStore
      : op.vendor === DATA_VENDOR
        ? dataStore
        : undefined;
    const at = Date.now();
    const records = (outcome: (i: number) => { output: unknown } | { error: ErrorInfo }): LedgerRecord[] =>
      calls.map((c, i) => ({
        v: 1,
        app: this.config.appName,
        id: `${runId}:op.called:${i}`,
        runId,
        seq: i,
        at,
        actor,
        workflow: CALL_WORKFLOW,
        type: "op.called",
        op: c.op.id,
        ...targetOf(c.op, c.input),
        effect: c.op.effect,
        input: recorded(c.op, c.input),
        decision: decisions[i]!,
        ...(context.connection && { connection: context.connection }),
        ...outcome(i),
        durationMs: Date.now() - at,
      }));
    const made = (result: unknown) => {
      const outputs = outputsOf(op, result);
      return records((i) => ({ output: recorded(calls[i]!.op, outputs[i]) }));
    };
    /** Runs the call through `fn`; a failure is recorded on the store's own connection, outside any transaction. */
    const output = async (fn: typeof call.fn): Promise<unknown> => {
      try {
        return await outputOf(op, () => fn(parsed, context));
      } catch (err) {
        for (const record of records(() => ({ error: errorInfo(err) }))) await this.audit.store.append(record);
        throw err;
      }
    };
    if (ledger || !transactionStore) {
      const result = await output(call.fn);
      for (const record of made(result)) await this.audit.store.append(record);
      return result;
    }
    // The write and its records in one transaction: the metadata or collection driver runs on the
    // transaction's connection (neither has an env guard), and a record another write of the id
    // was first with rolls the write back, for the recorded output to stand.
    const store = await transactionStore.db();
    try {
      return await store.transaction(async (tx) => {
        const fn = (
          connectionMutation
            ? connectionDriver(this.config.connections.onDatabase(tx))
            : collectionsDriver([collections.get(op.resource)!], { db: async () => tx })
        ).ops[`${op.resource}.${op.name}`]!;
        const result = await output(fn);
        for (const record of made(result)) if (!(await insertRecord(tx, record))) tx.rollback();
        return result;
      });
    } catch (err) {
      if (!is(err, TransactionRollbackError)) throw err;
      const first = await this.recordedCall(runId, op, calls, context.connection);
      if (!first || "partial" in first) throw err;
      return first.output;
    }
  }

  /**
   * What the direct write recorded as `runId` returned, when one did (a batch's output from its
   * entries' records): refused (`invalid_input`) when it was of another operation or input, its
   * failure again (`driver_failed`) when it failed, and `partial` when fewer records than its
   * calls are there (a batch's, appended one by one outside a transaction, cut short).
   */
  private async recordedCall(
    runId: string,
    op: Op,
    calls: readonly Call[],
    connection?: ConnectionSnapshot,
  ): Promise<{ output: unknown } | { partial: true } | undefined> {
    const made = (await this.audit.store.read(runId)).filter((r) => r.type === "op.called");
    if (!made.length) return undefined;
    const same = (what: (record: (typeof made)[number], call: Call) => boolean) =>
      made.length <= calls.length && made.every((r, i) => what(r, calls[i]!));
    const differs = [
      ...(same((r, c) => r.op === c.op.id) ? [] : ["op"]),
      ...(same((r, c) => sameJson(r.input, recorded(c.op, c.input))) ? [] : ["input"]),
      ...(sameJson(made[0]!.connection ?? null, connection ?? null) ? [] : ["connection"]),
    ];
    if (differs.length) {
      throw new SanomaError(
        "invalid_input",
        `Call ${runId} was made already with a different ${differs.join(" and ")}; use another id`,
        { runId, differs },
      );
    }
    const failed = made.find((r) => r.error);
    if (failed?.error) {
      throw new SanomaError(
        "driver_failed",
        `${op.id} failed when first called as ${runId}: ${failed.error.message}; call again with another id`,
        { runId, op: op.id, error: failed.error },
      );
    }
    if (made.length < calls.length) return { partial: true };
    return { output: isBatch(op) ? made.map((r) => r.output) : made[0]!.output };
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

  /** Records that the declared `person` signed in to the staff login, by `method`: a ledger record outside any run. */
  async recordSignIn(person: string, method: SignInMethod): Promise<void> {
    const actor = await this.admitted({ id: person });
    await this.audit.store.append(
      loginRecord(this.config.appName, actor, { type: "signin.recorded", person: actor.id, method }),
    );
  }

  /** Records that `by` minted an invite for the declared `person`, good until `expiresAt`: a ledger record outside any run. */
  async recordInvite(person: string, options: { by: string; expiresAt: Date }): Promise<void> {
    const [actor, invited] = await Promise.all([this.admitted({ id: options.by }), this.admitted({ id: person })]);
    await this.audit.store.append(
      loginRecord(this.config.appName, actor, {
        type: "invite.minted",
        person: invited.id,
        by: actor.id,
        expiresAt: options.expiresAt.toISOString(),
      }),
    );
  }

  /**
   * Spends a sealed invite request's `nonce` (`openInvite`), good until `expiresAt`: true the first
   * time, false when it was spent already, in this process or another.
   */
  async spendInviteRequest(nonce: string, expiresAt: Date): Promise<boolean> {
    return spendInviteRequest(await this.database.db(), nonce, expiresAt);
  }

  /** When each of `people` last signed in to the staff login, and how, by id (`recordSignIn`); one who never did is left out. */
  lastSignIns(people: readonly string[]): Promise<Record<string, { at: number; method: SignInMethod }>> {
    return lastSignIns(this.audit.store, people);
  }

  /** Who minted the latest invite for the declared `person`, when, and until when (`recordInvite`); undefined when nobody did. */
  lastInvite(person: string): Promise<{ by: string; at: number; expiresAt: number } | undefined> {
    return lastInvite(this.audit.store, person);
  }

  /** The run's audit record, in order, from the ledger store. */
  async ledger(runId: string): Promise<LedgerRecord[]> {
    await this.mustExist(runId);
    return this.audit.store.read(runId);
  }

  /**
   * The calls that acted on `target` (a collection's record, `data:outbound/Acme`; a resource
   * instance) across every run, direct writes among them, newest first, at most `limit`.
   */
  history(target: string, limit: number = LIST_LIMIT.default): Promise<LedgerRecord[]> {
    return this.audit.store.readByTarget(target, limit);
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
    const { target, row } = await this.pendingApproval(runId, approvalId);
    const reason = refusalOf(
      target,
      msg.by,
      { actor: row.authenticatedUser ? { id: row.authenticatedUser } : undefined },
      declared.people,
    );
    if (reason !== undefined) throw notApprover(runId, target, reason);
    // The id names this message, so the run's answer says whether it decided with it, and is
    // in its idempotency key, so a retried send queues it once.
    const id = msg.id ?? randomUUID();
    return this.sendToApproval(runId, target, { ...msg, id }, options.timeoutSeconds);
  }

  /**
   * Withdraws the run's pending approval `approvalId`, saying `reason`, as `options.by`: the run's
   * starter, or someone who may decide it (`not_approver` otherwise, here and again in the run,
   * which records who withdrew it). The run reads the
   * withdrawal as a decision, and the step that waits on it throws `approval_withdrawn`. Returns
   * the approval as withdrawn, and refuses as `decide` does: `already_decided` when it is not
   * pending (or another decision reached the run first), `run_ended`, `no_pending_approval`,
   * `run_not_found`; and returns it still `pending` when the run does not read the withdrawal
   * within `timeoutSeconds` (30 by default).
   */
  async withdraw(
    runId: string,
    approvalId: string,
    reason: string,
    options: { by: Principal | string; timeoutSeconds?: number },
  ): Promise<ApprovalState> {
    const withdraw = parseOrThrow(ApprovalWithdrawal.shape.withdraw, reason, "A withdrawal needs a reason");
    const by = await this.admitted(
      parseOrThrow(PrincipalOrId, options?.by, '`by` must be a principal, such as "alice" or { id: "alice" }'),
    );
    const { target, row } = await this.pendingApproval(runId, approvalId);
    const refusal = withdrawalRefusal(target, by, row.authenticatedUser);
    if (refusal !== undefined) throw notApprover(runId, target, refusal);
    const id = randomUUID();
    return this.sendToApproval(runId, target, { withdraw, by, id }, options.timeoutSeconds);
  }

  /**
   * The run's approval `approvalId` (else its first pending one) and the run's row, when the
   * approval is pending on a run that has not ended: `already_decided`, `run_ended`,
   * `no_pending_approval` or `run_not_found` otherwise.
   */
  private async pendingApproval(runId: string, approvalId: string | undefined) {
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
    return { target, row };
  }

  /**
   * Sends a message with an `id` to the approval and waits up to `timeoutSeconds` (30 by
   * default) for the run to read it: the approval as the run then has it, still `pending` if it
   * has not read it. `not_approver` when the run refused it, `already_decided` when another
   * message decided it first.
   */
  private async sendToApproval(
    runId: string,
    target: ApprovalState,
    message: (ApprovalMessage | ApprovalWithdrawal) & { id: string },
    timeoutSeconds = 30,
  ): Promise<ApprovalState> {
    this.options.onWrite?.();
    await this.dbos.send(runId, message, topicOf(target.id), messageKeyOf(target.id, message.id));
    // DBOSClient does not LISTEN for events: it polls, every 10 s unless told otherwise. A
    // running worker answers within moments, so poll often at first, then once a second.
    const event = decisionEventOf(target.id);
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
    const refused = now.refused.find((r) => r.id === message.id);
    if (refused) throw notApprover(runId, target, refused.reason);
    // Another message reached the run first.
    if (now.status !== "pending" && now.decidedWith !== message.id) throw alreadyDecided(runId, now);
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
   * Starts the built-in change workflow on the draft `input.id` (`ChangeInput`): its run id is
   * `change:<id>`, or `change:<id>~<n>` once that run has ended (the second `~2`). While a run of
   * the change has not ended, returns its id and starts nothing.
   */
  async openChange(input: ChangeInput, options: StartOptions): Promise<string> {
    const { id } = parseOrThrow(ChangeInput, input, "Not a change to open");
    return this.startOnDraft(CHANGE_WORKFLOW, id, input, options);
  }

  /**
   * Starts the built-in save of the draft `input.id` (`SaveDraftInput`): its run id is `save:<id>`,
   * or `save:<id>~<n>` once that run has ended. While a save of the draft has not ended, returns its
   * id and starts nothing.
   */
  async saveDraft(input: SaveDraftInput, options: StartOptions): Promise<string> {
    const { id } = parseOrThrow(SaveDraftInput, input, "Not a draft to save");
    return this.startOnDraft(SAVE_DRAFT_WORKFLOW, id, input, options);
  }

  /** The saves of the draft `id` (`saveDraft`), newest first, each with its input and, once finished, its output. */
  async saves(id: string): Promise<SaveView[]> {
    const rows = await this.draftRuns(SAVE_DRAFT_WORKFLOW, id, { load: true });
    return Promise.all(
      rows.map(async (row) => ({
        ...(await this.summarize(row)),
        input: (row.input as [RunArgs])[0].input as SaveDraftInput,
        ...(row.status === "SUCCESS" && { output: row.output as SaveDraftOutput }),
      })),
    );
  }

  /** Starts the built-in `workflow` on the draft `id` as `<prefix>:<id>`, `~<n>` after an ended one; an unended run of it is returned instead. */
  private async startOnDraft(
    workflow: keyof typeof DRAFT_RUNS,
    id: string,
    input: unknown,
    options: StartOptions,
  ): Promise<string> {
    const runs = await this.draftRuns(workflow, id);
    const open = runs.find((r) => !isEnded(runStatus(r.status, [])));
    if (open) return open.workflowID;
    const first = `${DRAFT_RUNS[workflow].prefix}:${id}`;
    const runId = runs.length ? `${first}~${runs.length + 1}` : first;
    return this.start(this.config.workflows.get(workflow)!, input, { ...options, runId });
  }

  /**
   * The changes, newest first, each draft's by its latest run (`change`): `open` ones (not ended)
   * or the others, else all; at most `limit` (20).
   */
  async changes({ open, limit = 20 }: ChangesFilter = {}): Promise<ChangeView[]> {
    const runs = await this.dbos.listWorkflows({
      workflowName: CHANGE_WORKFLOW,
      applicationName: this.config.appName,
      sortDesc: true,
      loadInput: false,
      loadOutput: false,
    });
    // A draft's later run (`~2`) is its change now: an earlier one is neither open nor done.
    const ended = new Set<string>(dbosStatusesOf(...ENDED_STATUSES));
    const ids = [...Map.groupBy(runs, (run) => changeIdOf(run.workflowID)).values()]
      .map(([run]) => run!)
      .filter((run) => open === undefined || ended.has(run.status) !== open)
      .slice(0, limit)
      .map((run) => run.workflowID);
    if (ids.length === 0) return [];
    const rows = await this.dbos.listWorkflows({ workflowIDs: ids, sortDesc: true, loadInput: true, loadOutput: true });
    return Promise.all(rows.map((row) => this.changeView(row)));
  }

  /**
   * Whether a change is merging or deploying `main` now (`ChangeState.phase`, as its run last
   * published it), which follows `main` and applies the hosts itself.
   */
  async changeDeploying(): Promise<boolean> {
    const rows = await this.dbos.listWorkflows({
      workflowName: CHANGE_WORKFLOW,
      applicationName: this.config.appName,
      status: dbosStatusesOf("queued", "running"),
      loadInput: false,
      loadOutput: false,
    });
    const phases = await Promise.all(
      rows.map(async (row) => (await this.dbos.getEvent<ChangeState>(row.workflowID, CHANGE_EVENT, 0))?.phase),
    );
    return phases.some((phase) => phase === "merging" || phase === "deploying");
  }

  /** The change of the draft `id`: its latest run's (`openChange`), or undefined when it has none. */
  async change(id: string): Promise<ChangeView | undefined> {
    const [row] = await this.draftRuns(CHANGE_WORKFLOW, id, { load: true });
    return row && this.changeView(row);
  }

  /**
   * Tells the change of the draft `id` what happened (`ChangeEvent`), as `options.by`: new commits
   * on its branch, a close asked for, or its pull request closed or merged on the host. The event is
   * queued for its latest run, which reads it when it next waits; a pending approval of the merge
   * (Publish, or a hold on it) is withdrawn as `by` (C4's `withdraw`), so a run waiting on it reads
   * the event now. A `close` is refused (`not_approver`) unless `by` may withdraw that approval; the
   * other kinds are facts, so a withdrawal `by` may not make is skipped and the run's merge refuses a
   * head that moved. `run_not_found` when the draft has no change, `run_ended` when its run has ended.
   * With `key`, an event told again under the same key is queued once while the run has not read it.
   */
  async changeEvent(id: string, event: ChangeEvent, options: { by: Principal | string; key?: string }): Promise<void> {
    const by = await this.admitted(
      parseOrThrow(PrincipalOrId, options?.by, '`by` must be a principal, such as "alice" or { id: "alice" }'),
    );
    const given = parseOrThrow(ChangeEventSchema, event, "Not a change event");
    // A close is asked for by whoever asks it, whatever the event names.
    const told: ChangeEvent = given.kind === "close" ? { kind: "close", by: by.id } : given;
    const [row] = await this.draftRuns(CHANGE_WORKFLOW, id);
    if (!row) throw new SanomaError("run_not_found", `The draft ${id} has no change`, { id });
    const runId = row.workflowID;
    const approvals = await this.approvals(runId);
    const status = runStatus(row.status, approvals);
    if (isEnded(status)) {
      throw new SanomaError("run_ended", `Run ${runId} has ${status}; it takes no more events`, { runId, status });
    }
    const held = approvals.find((a) => a.status === "pending" && a.covers.includes(CHANGE_MERGE));
    // A close is whoever may withdraw Publish's, or with none pending, the starter's or admin's.
    const refusal = withdrawalRefusal(held ?? { approver: { group: ADMIN } }, by, row.authenticatedUser);
    if (refusal !== undefined && told.kind === "close") {
      if (held) throw notApprover(runId, held, refusal);
      throw new SanomaError("not_approver", refusal, { runId, reason: refusal });
    }
    this.options.onWrite?.();
    await this.dbos.send(runId, told, CHANGE_TOPIC, options.key);
    if (held && refusal === undefined) {
      await this.withdraw(runId, held.id, WITHDRAWAL[told.kind], { by, timeoutSeconds: 5 }).catch((err: unknown) => {
        // Decided or ended meanwhile: the run reads the event when it next waits, if it does.
        if (!["already_decided", "run_ended", "no_pending_approval"].includes(errorCode(err) ?? "")) throw err;
      });
    }
  }

  /**
   * Starts the built-in follow workflow on what a host's webhook says happened (`RemoteEvent`,
   * from a remote half's `webhook`, verified), as the runtime's agent `host-check`: the worker,
   * which has the checkout, follows it there (`follow-workflow.ts`). Its run id is
   * `follow:<sha256 of the event>`, so a delivery told again is the one run. Its id.
   */
  async follow(event: RemoteEvent): Promise<string> {
    const parsed = parseOrThrow(RemoteEventSchema, event, "Not an event of a host's webhook");
    return this.start(FOLLOW_WORKFLOW, parsed, { startedBy: HOST_CHECK_AGENT, runId: followRunId(parsed) });
  }

  /**
   * Starts a turn of the chat `input.chat` on the person's new message `input.message`, already in
   * its transcript (`chats.upsert`), as `startedBy`, the chat's person: the built-in chat workflow,
   * as the run `chat:<chat>:<message>` (`chatRunId`), after the chat's turn before it, which it
   * waits for; that turn, when it has not ended, is told to stop. The worker runs the turn and
   * writes its reply (`chats.chunks`, then the transcript). Its run id.
   */
  async startTurn(input: Omit<ChatTurnInput, "after">, options: StartOptions): Promise<string> {
    const runId = chatRunId(input.chat, input.message);
    // The latest other than this one, which a start told again finds first.
    const before = (await this.turns(input.chat, 2)).find((row) => row.workflowID !== runId);
    await this.start(CHAT_WORKFLOW, { ...input, ...(before && { after: before.workflowID }) } satisfies ChatTurnInput, {
      ...options,
      runId,
    });
    // Once the new turn stands, which refused anyone but the chat's person.
    if (before && !isEnded(runStatus(before.status, []))) {
      await this.dbos.send(before.workflowID, { kind: "stop" } satisfies ChatTell, CHAT_TOPIC);
    }
    return runId;
  }

  /** The chat's latest turn (`startTurn`), or undefined when it has had none. */
  async turn(chat: string): Promise<RunSummary | undefined> {
    const [row] = await this.turns(chat, 1);
    return row && this.summarize(row);
  }

  /**
   * Hands `code`, which the person pasted on their own agent's sign-in card, to the sign-in waiting
   * in the turn under way of their chat `chat`, sealed (`sealChatCode`), so the run's messages never
   * show it. `run_not_found` when the chat has no turn under way of `by`'s.
   */
  async turnCode(chat: string, code: string, options: { by: Principal | string }): Promise<void> {
    const by = await this.admitted(
      parseOrThrow(PrincipalOrId, options?.by, '`by` must be a principal, such as "alice" or { id: "alice" }'),
    );
    const [row] = await this.turns(chat, 1);
    if (!row || isEnded(runStatus(row.status, [])) || row.authenticatedUser !== by.id) {
      throw new SanomaError("run_not_found", `No turn of chat ${chat} is under way`, { chat });
    }
    const told: ChatTell = { kind: "code", sealed: sealChatCode(row.workflowID, code) };
    await this.dbos.send(row.workflowID, told, CHAT_TOPIC);
  }

  /**
   * How far the app `folder` (taken from a source) is behind its source, or why that cannot be
   * told, as the worker last checked (at its start and after the checkout follows `main`);
   * undefined when it has not told it.
   */
  async appBehind(folder: string): Promise<AppBehind | undefined> {
    return readAppBehind(await this.database.db(), folder);
  }

  /** A sandbox run's checks against its scenario as the worker last ran them (when the run last waited or ended); undefined for none yet. */
  async runChecks(runId: string): Promise<RunChecks | undefined> {
    return readRunChecks(await this.database.db(), runId);
  }

  /** The latest `limit` turns of the chat `chat`, newest first: its runs `chat:<chat>:<message>` (`chatRunPrefix`). */
  private async turns(chat: string, limit: number) {
    return this.dbos.listWorkflows({
      // DBOS matches the prefix with LIKE as given, where a chat id's `_` is any character: escaped.
      workflow_id_prefix: chatRunPrefix(chat).replaceAll(/[\\%_]/g, "\\$&"),
      workflowName: CHAT_WORKFLOW,
      applicationName: this.config.appName,
      sortDesc: true,
      limit,
      loadInput: false,
      loadOutput: false,
    });
  }

  /** The runs of the built-in `workflow` on the draft `id`, newest first: `<prefix>:<id>` and `<prefix>:<id>~<n>`. */
  private async draftRuns(workflow: keyof typeof DRAFT_RUNS, id: string, { load = false } = {}) {
    const { prefix, idOf } = DRAFT_RUNS[workflow];
    const rows = await this.dbos.listWorkflows({
      workflow_id_prefix: `${prefix}:${id}`,
      workflowName: workflow,
      applicationName: this.config.appName,
      sortDesc: true,
      loadInput: load,
      loadOutput: load,
    });
    return rows.filter((r) => idOf(r.workflowID) === id);
  }

  /** A change run's row as the app shows it: its summary, its last `ChangeState` and, once finished, its report. */
  private async changeView(row: Parameters<SanomaClient["summarize"]>[0] & { input?: unknown; output?: unknown }) {
    const [summary, published] = await Promise.all([
      this.summarize(row),
      this.dbos.getEvent<ChangeState>(row.workflowID, CHANGE_EVENT, 0),
    ]);
    const input = (row.input as [RunArgs])[0].input as ChangeInput;
    const state = published ?? initialChangeState(input);
    const { runId, status, startedBy, createdAt, updatedAt, approvals } = summary;
    return {
      runId,
      status,
      ...(startedBy && { startedBy }),
      createdAt,
      ...(updatedAt !== undefined && { updatedAt }),
      approvals,
      state,
      ...(row.status === "SUCCESS" && { report: row.output as ChangeReport }),
    } satisfies ChangeView;
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
    const current = await this.storedSecrets.read(name);
    await this.storedSecrets.write(name, value, { expectedVersion: current?.version ?? null, by: setBy });
  }

  /**
   * Deletes the stored value of a declared variable, and tells the workers, which unset it unless
   * their environment sets it. `by` is who asks; nothing records it once the row is gone.
   * Refuses (`invalid_input`) a name no driver declares, and `by` as `setCredential` does.
   */
  async clearCredential(name: string, options: { by: string }): Promise<void> {
    await this.admittedBy(options);
    this.declared(name, () => undefined);
    const current = await this.storedSecrets.read(name);
    if (current) await this.storedSecrets.delete(name, { expectedVersion: current.version, by: options.by });
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
    const current = await this.storedSecrets.read(name);
    await this.storedSecrets.write(name, value, { expectedVersion: current?.version ?? null, by: setBy });
  }

  /** Removes a logical secret from the selected store; external bindings remain read-only. */
  async clearSecret(name: string, options: { by: string }): Promise<void> {
    const by = await this.admittedBy(options);
    if (!VARIABLE.test(name)) {
      const message = "That is not a variable name";
      throw new SanomaError("invalid_input", message, {
        issues: [{ path: ["name"], message, code: "custom" }],
      });
    }
    const current = await this.storedSecrets.read(name);
    if (current) await this.storedSecrets.delete(name, { expectedVersion: current.version, by });
  }

  private connectionAuthorization(): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: this.config.version,
          policies: this.config.policies,
          problems: this.config.policyProblems,
        }),
      )
      .digest("hex");
  }

  /** Safe account cards, scoped to the admitted principal. No provider or secret reads. */
  async connections(options: { actor: Principal | string }): Promise<ConnectionCard[]> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    return this.config.connections.cards(actor.id);
  }

  /** Creation choices are scoped by code to the admitted person's current groups. */
  async connectionRules(options: { actor: Principal | string }): Promise<{ id: string; rule: ConnectionRule }[]> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    return [...this.config.connections.catalog.rules]
      .filter(([, rule]) =>
        rule.createBy.some((by) => (typeof by === "string" ? by === actor.id : actor.groups?.includes(by.group))),
      )
      .map(([id, rule]) => ({ id, rule }));
  }

  /** Readiness only, without reading or listing any credential. The adapter's bootstrap
   * authority is checked by validate; provider details never escape this boundary. */
  async secretStoreStatus(options: { actor: Principal | string }) {
    await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    const { store, namespace } = this.storedSecrets;
    let problem: string | undefined;
    try {
      await this.storedSecrets.validate();
    } catch (error) {
      problem = (error as SecretStoreError).code;
    }
    return {
      store: store.id,
      namespace,
      capabilities: { ...store.capabilities },
      ready: !problem,
      ...(problem && { problem }),
    };
  }

  /** The latest moves of the secrets between stores, newest first, with each secret's receipt: names, versions' progress and sizes, never a value. */
  async storeMoves(options: { actor: Principal | string }): Promise<StoreMove[]> {
    await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    return readStoreMoves(await this.database.db());
  }

  /** Secure intake endpoint, never a workflow operation. Only its metadata-only prepare gate
   * enters policy/approval history; callers keep the value in a password form while reviewing. */
  async previewConnection(
    target: ConnectionTarget,
    credentials: unknown,
    options: { actor: Principal | string; id: string },
  ): Promise<ConnectionReview> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    const id = parseOrThrow(z.string().min(1).max(200), options.id, "Name the setup request");
    target = parseOrThrow(connectionTargetSchema, target, "Select a declared connection or creation rule");
    const setup = await this.config.connections.setup(target, actor, id);
    const authorized = (await this.call(
      "sanoma.connection.prepare",
      {
        target,
        requestId: id,
        definition: setup.definition,
        authorization: this.connectionAuthorization(),
      },
      { actor, id: `connection-prepare:${id}` },
    )) as ConnectionSetup;
    if (!isDeepStrictEqual(authorized, setup))
      throw new SanomaError("invalid_input", "The connection changed; start a new review");
    const method = this.config.connections.catalog.methods.get(setup.vendor)![setup.method]!;
    const external = setup.location?.management === "external" || !this.storedSecrets.store.capabilities.writable;
    if (!external && this.storedSecrets.store.capabilities.conditionalWrites === "none")
      throw new SecretStoreError("unsupported");
    if (credentials !== undefined && external) throw new SecretStoreError("read_only");
    const existing = setup.credential ? await this.storedSecrets.read(setup.credential) : undefined;
    if (external && !existing) throw new SecretStoreError("unavailable");
    const encoded = external ? existing!.value : encodeCredentials(method, credentials);
    const identity = await verifyAuthentication(method, decodeCredentials(method, encoded));
    if (setup.expectedAccount && setup.expectedAccount !== identity.account)
      throw new AuthenticationError("wrong_account");
    if (setup.requiredScopes.some((scope) => !identity.scopes.includes(scope)))
      throw new AuthenticationError("scope_changed");
    return {
      ...setup,
      requestId: id,
      authorization: this.connectionAuthorization(),
      account: identity.account,
      scopes: [...identity.scopes],
      credentialVersion: existing?.version ?? null,
      ...(identity.expiresAt !== undefined && { expiresAt: identity.expiresAt }),
    };
  }

  /** Reverify the reviewed authority, reserve its metadata under policy, then write the bundle
   * outside durable execution. Activation has its own policy gate and verifies what was saved. */
  async connectConnection(
    review: ConnectionReview,
    credentials: unknown,
    options: { actor: Principal | string },
  ): Promise<ConnectionSnapshot> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    if (review.authorization !== this.connectionAuthorization())
      throw new SanomaError("invalid_input", "The policy changed; start a new connection review");
    const setup = await this.config.connections.setup(review.target, actor, review.requestId);
    for (const field of ["id", "vendor", "method", "definition", "credential", "location"] as const) {
      if (!isDeepStrictEqual(setup[field], review[field]))
        throw new SanomaError("invalid_input", "The destination changed; review it again before saving");
    }
    // Reuse only the metadata gate, never a cached credential or verification result.
    await this.call(
      "sanoma.connection.prepare",
      {
        target: review.target,
        requestId: review.requestId,
        definition: setup.definition,
        authorization: review.authorization,
      },
      { actor, id: `connection-prepare:${review.requestId}` },
    );
    const method = this.config.connections.catalog.methods.get(setup.vendor)![setup.method]!;
    const external = setup.location?.management === "external" || !this.storedSecrets.store.capabilities.writable;
    if (!external && this.storedSecrets.store.capabilities.conditionalWrites === "none")
      throw new SecretStoreError("unsupported");
    if (credentials !== undefined && external) throw new SecretStoreError("read_only");
    const existing = setup.credential ? await this.storedSecrets.read(setup.credential) : undefined;
    if (external && (!existing || existing.version !== review.credentialVersion))
      throw new SecretStoreError("conflict");
    if (setup.expectedRevision === review.expectedRevision && (existing?.version ?? null) !== review.credentialVersion)
      throw new SecretStoreError("conflict");
    const encoded = external ? existing!.value : encodeCredentials(method, credentials);
    const identity = await verifyAuthentication(method, decodeCredentials(method, encoded));
    if (identity.account !== review.account) throw new AuthenticationError("wrong_account");
    if (JSON.stringify(identity.scopes) !== JSON.stringify([...new Set(review.scopes)].toSorted()))
      throw new AuthenticationError("scope_changed");
    const selected = (await this.call(
      "sanoma.connection.configure",
      {
        target: review.target,
        requestId: review.requestId,
        expectedRevision: review.expectedRevision,
        definition: review.definition,
        account: identity.account,
        scopes: [...identity.scopes],
      },
      { actor, id: `connection-configure:${review.requestId}` },
    )) as ConnectionSnapshot;
    const ref = { vendor: selected.vendor, $connection: selected.id };
    if ((await this.config.connections.setupState(selected, actor)) === "pending" && !external) {
      let written = false;
      try {
        const receipt = await this.config.connections.storedVersion(selected.id, selected.revision);
        if (receipt) {
          if (existing?.version !== receipt || existing.value !== encoded) throw new SecretStoreError("conflict");
        } else {
          const stored = await this.storedSecrets.write(setup.credential!, encoded, {
            expectedVersion: review.credentialVersion,
            by: actor.id,
          });
          written = true;
          await this.config.connections.recordStoredVersion(selected.id, selected.revision, stored.version);
        }
      } catch (error) {
        if (written || (error as { code?: string })?.code === "unavailable")
          await this.config.connections.uncertain(ref, selected.revision, actor.id);
        throw error;
      }
    }
    const connected = (await this.call(
      "sanoma.connection.activate",
      {
        connection: ref,
        expectedRevision: selected.revision,
      },
      { actor, id: `connection-activate:${review.requestId}` },
    )) as ConnectionSnapshot;
    await this.config.connections.assertCurrent(connected, actor.id);
    return connected;
  }

  /**
   * Starts OAuth consent for a connection whose method is `oauth2`, as secure intake on the
   * trusted server: the `sanoma.connection.authorize` gate under policy (metadata only, with
   * `replacesApplication` when `client` is given), the company's OAuth application written to the
   * connection's `client` secret when `client` is given (else the stored one is used), then an attempt whose state and PKCE verifier are kept
   * outside workflow history (`oauth.ts`). Returns the consent URL to open and the attempt's id,
   * which the app binds to the person's browser for the callback. `redirectUri` must be the app's
   * callback for the vendor (`connectionCallbackPath`), as registered with the provider.
   */
  async authorizeConnection(
    target: ConnectionTarget,
    options: { actor: Principal | string; id: string; redirectUri: string; client?: OAuthClient },
  ): Promise<{ attempt: string; url: string; expiresAt: number; connection: string }> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    const id = parseOrThrow(z.string().min(1).max(200), options.id, "Name the setup request");
    target = parseOrThrow(connectionTargetSchema, target, "Select a declared connection or creation rule");
    const redirectUri = parseOrThrow(z.string().url(), options.redirectUri, "Give the callback's URL");
    const setup = await this.config.connections.setup(target, actor, id);
    const method = this.config.connections.catalog.methods.get(setup.vendor)![setup.method]!;
    if (method.kind !== "oauth2" || !setup.client || !setup.credential)
      throw new SanomaError("invalid_input", "This connection's method does not connect by OAuth consent");
    if (new URL(redirectUri).pathname !== connectionCallbackPath(setup.vendor))
      throw new SanomaError("invalid_input", `The callback must be ${connectionCallbackPath(setup.vendor)}`);
    const authorized = (await this.call(
      "sanoma.connection.authorize",
      {
        target,
        requestId: id,
        definition: setup.definition,
        redirectUri,
        replacesApplication: options.client !== undefined,
        authorization: this.connectionAuthorization(),
      },
      { actor, id: `connection-authorize:${id}` },
    )) as ConnectionSetup;
    if (!isDeepStrictEqual(authorized, setup))
      throw new SanomaError("invalid_input", "The connection changed; start connecting again");
    const current = await this.storedSecrets.read(setup.client);
    let application: OAuthClient;
    if (options.client !== undefined) {
      application = parseOrThrow(oauthClient, options.client, "Enter the OAuth application's client ID and secret");
      await this.storedSecrets.write(setup.client, encodeCredentials(oauthApplication, application), {
        expectedVersion: current?.version ?? null,
        by: actor.id,
      });
    } else if (current) application = decodeCredentials(oauthApplication, current.value);
    else throw new SanomaError("invalid_input", "Enter the OAuth application's client ID and secret: none is stored");
    // The attempt keeps the revision consented to: the exchange refuses a connection changed since.
    const consented: ConnectionTarget =
      "connection" in target
        ? {
            connection: {
              vendor: target.connection.vendor,
              $connection: target.connection.$connection,
              ...(setup.expectedRevision !== null && { revision: setup.expectedRevision }),
            },
          }
        : target;
    const started = await this.config.connections.attempts.start({
      flow: method.oauth,
      connectionId: setup.id,
      target: consented,
      requestId: id,
      principal: actor.id,
      clientId: application.clientId,
      redirectUri,
    });
    return { ...started, connection: setup.id };
  }

  /**
   * The provider's callback, from the app's route for `vendor`: the attempt the person's browser
   * holds checked against `params`' state as the person who started it (`actor`), its code
   * sealed into the attempt, then the built-in `connect` run started as them, given the attempt's
   * id alone (`connect:<attempt>`). Throws a `CallbackError` (`oauth.ts`) for a mismatched,
   * replayed, expired or declined callback. Returns the connection and the run.
   */
  async receiveConnection(
    vendor: string,
    attempt: string,
    params: URLSearchParams,
    options: { actor: Principal | string },
  ): Promise<{ connection: string; runId: string }> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    const { attempts, catalog } = this.config.connections;
    const received = await attempts.receive(attempt, actor.id, params, async (row) => {
      if (
        !row.connectionId.startsWith(`${vendor}/`) ||
        new URL(row.redirectUri).pathname !== connectionCallbackPath(vendor)
      )
        return undefined;
      const setup = await this.config.connections.setup(row.target, actor, row.requestId);
      const method = catalog.methods.get(setup.vendor)?.[setup.method];
      return method?.kind === "oauth2" ? method.oauth : undefined;
    });
    const runId = connectRunId(attempt);
    try {
      await this.start(
        CONNECT_WORKFLOW,
        { target: received.target, requestId: received.requestId, attempt },
        { startedBy: actor, runId },
      );
    } catch (error) {
      // No run will take the sealed code: end the attempt, so its page says so and drops the code.
      await attempts.settle(attempt, actor.id, "unavailable");
      throw error;
    }
    return { connection: received.connectionId, runId };
  }

  /**
   * Where the person's OAuth attempt is, for the page that waits on it: waiting for consent,
   * exchanging (the `connect` run queued, running or held for an approval), connected, or failed
   * with its problem. Metadata only; refused for an attempt that is not the person's.
   */
  async connectionAttempt(attempt: string, options: { actor: Principal | string }): Promise<AttemptStatus> {
    const actor = await this.admitted(parseOrThrow(PrincipalOrId, options.actor, "Name the principal"));
    const row = await this.config.connections.attempts.get(attempt, actor.id);
    if (!row) throw new SanomaError("invalid_input", "No such connection attempt");
    const connection = row.connectionId;
    const runId = connectRunId(attempt);
    const run = row.received ? await this.run(runId) : undefined;
    const ran = run && { runId };
    if (row.outcome && row.outcome !== "exchanged")
      return { state: "failed", connection, problem: row.outcome, ...ran };
    if (!run) {
      return row.received || row.expiresAt.getTime() > Date.now()
        ? { state: row.received ? "exchanging" : "waiting", connection }
        : { state: "failed", connection, problem: "expired" };
    }
    if (run.status === "finished") return { state: "connected", connection, runId };
    if (isEnded(run.status)) return { state: "failed", connection, problem: "unavailable", runId };
    return { state: "exchanging", connection, ...(run.status === "waiting" && { problem: "approval_pending" }), runId };
  }

  /**
   * Values resolved through the selected store and explicit bindings, with version and change
   * metadata. Missing names are left out. Server code only; pages receive status, never values.
   */
  async secrets(names: readonly string[]): Promise<Map<string, StoredSecret>> {
    const found = new Map<string, StoredSecret>();
    for (const name of names) {
      const row = await this.storedSecrets.read(name);
      const location = this.storedSecrets.location(name);
      if (row)
        found.set(name, {
          value: row.value,
          source: location.store === "environment" ? "environment" : "stored",
          version: row.version,
          location,
          ...(row.updatedBy && { setBy: row.updatedBy }),
          ...(row.updatedAt && { setAt: row.updatedAt }),
        });
    }
    return found;
  }

  /** Non-secret statuses for the selected store and declared bindings. */
  async credentials(): Promise<Map<string, CredentialStatus[]>> {
    const names = [...credentialsOf(this.drivers, () => undefined).values()].flat().map((c) => c.name);
    const rows = await this.secrets(names);
    const statuses = credentialsOf(this.drivers, (name) => rows.get(name)?.value);
    return new Map(
      [...statuses].map(([vendor, list]) => [
        vendor,
        list.map((c) => {
          const row = rows.get(c.name);
          return {
            ...c,
            location: this.storedSecrets.location(c.name),
            ...(row && { source: row.source, setBy: row.setBy, setAt: row.setAt }),
          };
        }),
      ]),
    );
  }

  async close() {
    await Promise.all([
      this.storedSecrets.close(),
      this.config.connections.close(),
      this.config.identityProvisioning.close(),
      this.dbos.destroy(),
      this.database.close(),
      this.audit.close(),
      this.config.dataStore?.close(),
      this.config.connectionStore.close(),
    ]);
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

  /** The pool the client reads and writes with, once the database is prepared: what a login runs on (`LoginContext.database`). */
  pool(): Promise<Pool> {
    return this.database.pool();
  }

  /**
   * The principal as the data files declare it (`admit`): its id alone is taken, never the groups
   * a caller gives, and an id nobody declares is `not_admitted`.
   */
  private async admitted(principal: Principal): Promise<Principal> {
    return admit(principal, readPeople(this.config.root));
  }

  /** An api token's principal (`token:<id>`) with the subject its row acts for, refused once the token is revoked; anyone else as given. */
  private async withSubject(principal: Principal): Promise<Principal> {
    if (!isToken(principal)) return principal;
    const subject = await this.tokens.subjectOf(principal.id.slice("token:".length));
    if (subject === undefined) throw new NotAdmittedError(principal.id);
    return { ...principal, subject };
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
    scheduleName?: string;
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
        : // DBOS enqueues a schedule's tick as nobody; the run starts as the schedule's agent.
          r.scheduleName
          ? { id: SCHEDULE_AGENT }
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
  version?: string;
  location?: SecretLocation;
  value: string;
  source: "environment" | "stored";
  /** Who stored it (`setSecret`'s `by`), and when, as an ISO 8601 time. */
  setBy?: string;
  setAt?: string;
}

/** What an environment variable's name looks like. */
const VARIABLE = /^[A-Z][A-Z0-9_]*$/;

const alreadyDecided = (runId: string, a: ApprovalState) =>
  new SanomaError(
    "already_decided",
    a.status === "withdrawn"
      ? `${a.id} on run ${runId} was already withdrawn: ${a.withdrawnReason}`
      : `${a.id} on run ${runId} was already ${a.status} by ${a.decidedBy}`,
    {
      runId,
      approvalId: a.id,
      status: a.status,
      ...(a.decidedBy === undefined ? {} : { decidedBy: a.decidedBy }),
      ...(a.withdrawnReason === undefined ? {} : { withdrawnReason: a.withdrawnReason }),
    },
  );

/**
 * The built-ins only one of the client's methods starts, by name: that method (`by`), and whether
 * a start is its own (`admits`), which `start` asks once the policy has (a visitor is denied
 * first), refusing any other: a change under the id `openChange` names; a follow as `host-check`
 * under its event's id; a chat turn under its chat's and message's id, after a turn of the same
 * chat, as the chat's person.
 */
const OWN_STARTS: Record<
  string,
  {
    by: string;
    admits(
      input: any,
      startedBy: Principal,
      runId: string | undefined,
      client: SanomaClient,
    ): boolean | Promise<boolean>;
  }
> = {
  [CHANGE_WORKFLOW]: {
    by: "openChange",
    admits: (input: ChangeInput, _by, runId) => runId !== undefined && changeIdOf(runId) === input.id,
  },
  [SAVE_DRAFT_WORKFLOW]: {
    by: "saveDraft",
    admits: (input: SaveDraftInput, _by, runId) => runId !== undefined && saveIdOf(runId) === input.id,
  },
  [FOLLOW_WORKFLOW]: {
    by: "follow",
    admits: (event: RemoteEvent, by, runId) => runId === followRunId(event) && by.id === HOST_CHECK_AGENT,
  },
  // The callback's: the attempt's own run. The exchange takes the attempt only as the person who started it.
  [CONNECT_WORKFLOW]: {
    by: "receiveConnection",
    admits: ({ attempt }: { attempt: string }, _by, runId) => runId === connectRunId(attempt),
  },
  [CHAT_WORKFLOW]: {
    by: "startTurn",
    admits: async ({ chat, message, after }: ChatTurnInput, by, runId, client) =>
      runId === chatRunId(chat, message) &&
      (after === undefined ||
        (after.startsWith(chatRunPrefix(chat)) && DRAFT_ID.test(after.slice(chatRunPrefix(chat).length)))) &&
      (await client.chats.get(chat))?.person === by.id,
  },
};

/**
 * A follow's run id (`SanomaClient.follow`): `follow:` and the SHA-256 of the event as its schema
 * parsed it, its keys then in the schema's order, so one event is one id however its JSON was laid out.
 */
const followRunId = (parsed: RemoteEvent) =>
  `follow:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;

/** The built-ins run on a draft, by name: their run ids' prefix (`<prefix>:<draft id>`), and the draft a run id is of. */
const DRAFT_RUNS = {
  [CHANGE_WORKFLOW]: { prefix: "change", idOf: changeIdOf },
  [SAVE_DRAFT_WORKFLOW]: { prefix: "save", idOf: saveIdOf },
} as const;

/** Why a change event withdraws the merge's pending approval. */
const WITHDRAWAL: Record<ChangeEvent["kind"], string> = {
  commits: "The change has new commits",
  close: "The change is being closed",
  closed: "The pull request was closed on the host",
  merged: "The pull request was merged on the host",
};

const notApprover = (runId: string, a: ApprovalState, reason: string) =>
  new SanomaError("not_approver", `${reason} (${a.id})`, { runId, approvalId: a.id, approver: a.approver, reason });
