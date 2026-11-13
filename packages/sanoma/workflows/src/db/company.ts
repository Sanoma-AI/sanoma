import type { UIMessage, UIMessageChunk } from "ai";
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { ConnectionHealth, ConnectionStatus, ConnectionTarget } from "../connection.ts";
import type { AttemptOutcome } from "../oauth.ts";
import type { RenewalOutcome } from "../renewal.ts";
import type { LedgerRecord } from "../ledger.ts";
import type { RunCheck } from "../scenario.ts";
import type { SecretLocation } from "../secret-store.ts";
import type { MoveItemAction, MoveItemKind, MoveItemState, MovePhase } from "../store-move.ts";

// The runtime's tables in a company's database, beside DBOS's: what `prepareDatabase` makes and
// every store reads. Column names are the property names in snake_case (`casing` in `db.ts` and
// in `drizzle/company.config.ts`). A change here is a new migration: `pnpm --filter
// sanoma generate` writes it under `drizzle/company/`, and CI refuses a schema
// whose migration was not generated.
//
// Every table has row-level security on and no policy (`enableRLS`, never FORCE): a floor, not
// the policy, which the runtime decides per call. The runtime's login makes the tables, so it
// owns them and passes; any other role (Supabase's `anon` and `authenticated` among them) reads
// no row and writes none, whatever it was granted. A role that serves the runtime must own them:
// one holding grants alone would read nothing. `db.test.ts` fails on a table without it.

const when = () => timestamp({ withTimezone: true });

/** The credentials set from the app, each sealed under its namespace and name. */
export const credentials = pgTable(
  "sanoma_credentials",
  {
    namespace: text().notNull(),
    name: text().notNull(),
    value: text().notNull(),
    version: text().notNull(),
    setBy: text().notNull(),
    setAt: when()
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.namespace, t.name] })],
).enableRLS();

/**
 * The Postgres ledger's records. `n` is the write order, `id` the record's, which the first write
 * of takes, and `seq` the record's place in its run: a run reads in `seq` order, then write order.
 * `target` is the JSON's (an `op.called`'s instance), kept by Postgres, for a record's history.
 */
export const ledger = pgTable(
  "sanoma_ledger",
  {
    n: bigserial({ mode: "number" }).primaryKey(),
    id: text().notNull().unique(),
    runId: text().notNull(),
    seq: integer().notNull(),
    record: jsonb().$type<LedgerRecord>().notNull(),
    target: text().generatedAlwaysAs(sql`"record" ->> 'target'`),
  },
  (t) => [
    index("sanoma_ledger_run_seq").on(t.runId, t.seq, t.n),
    // Only the `op.called` records carry a target: the others stay out of the index.
    index("sanoma_ledger_target")
      .on(t.target)
      .where(sql`${t.target} is not null`),
  ],
).enableRLS();

/** The collections' records (`collection.ts`): one row per collection and key, the record as JSON. */
export const data = pgTable(
  "sanoma_data",
  {
    collection: text().notNull(),
    key: text().notNull(),
    record: jsonb().$type<Record<string, unknown>>().notNull(),
    updatedAt: when().notNull().defaultNow(),
    updatedBy: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.collection, t.key] })],
).enableRLS();

/**
 * The instance's side of its wakeup: one row, made with the table (`0001_wakeup_row.sql`). `at`
 * is the deadline last registered, `stopped_at` when the worker last stopped itself (the
 * schedules backfill from it), `last_error` why the last registration failed.
 */
export const wakeup = pgTable(
  "sanoma_wakeup",
  {
    id: integer().primaryKey(),
    at: when(),
    stoppedAt: when(),
    lastError: text(),
  },
  (t) => [check("sanoma_wakeup_one_row", sql`${t.id} = 1`)],
).enableRLS();

/** The operator agent's chats (`chats.ts`): who each is for, its engine, its draft and the turn last begun (its run's id). */
export const chats = pgTable(
  "sanoma_chats",
  {
    id: text().primaryKey(),
    person: text().notNull(),
    engine: text().notNull(),
    draftId: text(),
    title: text().notNull(),
    createdAt: when().notNull().defaultNow(),
    turn: text(),
  },
  (t) => [index("sanoma_chats_person").on(t.person, t.createdAt)],
).enableRLS();

/** Each chat's messages, the AI SDK's UI messages as JSON, in `seq` order. */
export const chatMessages = pgTable(
  "sanoma_chat_messages",
  {
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    id: text().notNull(),
    seq: integer().notNull(),
    message: jsonb().$type<UIMessage>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.id] })],
).enableRLS();

/**
 * The reply a chat turn streams, as the worker writes it (`Chats.append`): its UI message stream's
 * chunks in `seq` order, then a row with none, its end. The app streams them to the browser; a
 * chat's turn's rows go when its next turn begins.
 */
export const chatChunks = pgTable(
  "sanoma_chat_chunks",
  {
    chatId: text()
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    runId: text().notNull(),
    seq: integer().notNull(),
    chunk: jsonb().$type<UIMessageChunk>(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] }), index("sanoma_chat_chunks_chat").on(t.chatId)],
).enableRLS();

/** The api tokens (`tokens.ts`): each one's SHA-256, never the token, whom it acts for, its groups, and when it was revoked. */
export const apiTokens = pgTable("sanoma_api_tokens", {
  id: text().primaryKey(),
  hash: text().notNull().unique(),
  subject: text().notNull(),
  groups: jsonb().$type<string[]>().notNull(),
  createdAt: when().notNull().defaultNow(),
  revokedAt: when(),
}).enableRLS();

/**
 * The api tokens' one-time handoffs (`Tokens.handoff`): each code's SHA-256, never the code, the
 * secret holding the token it hands off and that token's id, its PKCE challenge, and when it
 * expires or was redeemed. Swept once expired.
 */
export const tokenHandoffs = pgTable("sanoma_token_handoffs", {
  codeHash: text().primaryKey(),
  store: text().notNull(),
  tokenId: text().notNull(),
  challenge: text().notNull(),
  expiresAt: when().notNull(),
  redeemedAt: when(),
}).enableRLS();

/** The nonces of sealed invite requests spent (`spendInviteRequest`), each until it expires. */
export const inviteRequests = pgTable("sanoma_invite_requests", {
  nonce: text().primaryKey(),
  expiresAt: when().notNull(),
}).enableRLS();

/** The connected accounts (`connection.ts`): metadata only, never an authentication value. */
export const connections = pgTable("sanoma_connections", {
  id: text().primaryKey(),
  vendor: text().notNull(),
  method: text().notNull(),
  owner: text(),
  rule: text(),
  account: text().notNull(),
  scopes: jsonb().$type<string[]>().notNull(),
  revision: text().notNull(),
  definition: text().notNull(),
  credential: text(),
  location: jsonb().$type<SecretLocation>(),
  status: text().$type<ConnectionStatus>().notNull().default("connected"),
  updatedBy: text().notNull(),
  updatedAt: when()
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`),
}).enableRLS();

/** Each connection's last health check. */
export const connectionHealth = pgTable("sanoma_connection_health", {
  connectionId: text().primaryKey(),
  revision: text().notNull(),
  health: text().$type<ConnectionHealth["state"]>().notNull(),
  credentialVersion: text(),
  externallyRenewed: boolean().notNull(),
  checkedAt: when().notNull().defaultNow(),
  /** When the verified credential stops working, as its verifier said; null for none given. */
  expiresAt: when(),
}).enableRLS();

/** The receipts of a connection's setup, one per revision. */
export const connectionSetups = pgTable(
  "sanoma_connection_setups",
  {
    connectionId: text().notNull(),
    revision: text().notNull(),
    credentialVersion: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.revision] })],
).enableRLS();

/**
 * An OAuth consent attempt (`oauth.ts`), from Connect to the exchange: the state's hash and the
 * PKCE verifier from the start, the authorization code from the callback, each sealed for its
 * attempt, and both cleared when the exchange takes them, once. Kept outside workflow history,
 * which is given only `id`; swept once expired.
 */
export const connectionAttempts = pgTable("sanoma_connection_attempts", {
  id: text().primaryKey(),
  connectionId: text().notNull(),
  target: jsonb().$type<ConnectionTarget>().notNull(),
  requestId: text().notNull(),
  principal: text().notNull(),
  clientId: text().notNull(),
  redirectUri: text().notNull(),
  stateHash: text().notNull(),
  verifier: text(),
  code: text(),
  outcome: text().$type<AttemptOutcome>(),
  expiresAt: when().notNull(),
  receivedAt: when(),
  consumedAt: when(),
  createdAt: when().notNull().defaultNow(),
}).enableRLS();

/**
 * Each OAuth connection's renewal (`renewal.ts`): the lease one process holds while it renews the
 * grant (`holder`, until `leaseUntil`; `sentAt` once the refresh request may have reached the
 * provider), when it was last renewed and how that ended, and when the next renewal is due, the
 * deadline a worker that stops when idle registers with its wakeup. Metadata only, never a token.
 */
export const connectionRenewals = pgTable("sanoma_connection_renewals", {
  connectionId: text().primaryKey(),
  holder: text(),
  leaseUntil: when(),
  sentAt: when(),
  refreshedAt: when(),
  outcome: text().$type<RenewalOutcome>(),
  dueAt: when(),
}).enableRLS();

/**
 * How far each app taken from a source is behind it, as the worker last checked (`writeAppsBehind`):
 * one row per app folder, its count of commits or why it could not be told.
 */
export const appBehind = pgTable(
  "sanoma_app_behind",
  {
    folder: text().primaryKey(),
    behind: integer(),
    error: text(),
    checkedAt: when().notNull().defaultNow(),
  },
  (t) => [check("sanoma_app_behind_one_answer", sql`(${t.behind} IS NULL) <> (${t.error} IS NULL)`)],
).enableRLS();

/** Each sandbox run's checks against its scenario, as the worker last ran them (`recordChecks` in sandbox.ts): one row per run. */
export const runChecks = pgTable(
  "sanoma_run_checks",
  {
    runId: text().primaryKey(),
    checks: jsonb().$type<RunCheck[]>(),
    error: text(),
    checkedAt: when().notNull().defaultNow(),
  },
  (t) => [check("sanoma_run_checks_one_answer", sql`(${t.checks} IS NULL) <> (${t.error} IS NULL)`)],
).enableRLS();

/**
 * A move of the company's secrets from one store to another (`store-move.ts`, the built-in
 * `migrate-store`), by its run's id: the two stores by id and namespace, its phase, and whether
 * the source is fenced (`fenced`: writes there are refused, `configuredSecrets`), from its
 * transfer until it is cancelled or a later move cuts back over to that store. Metadata only.
 */
export const secretMoves = pgTable(
  "sanoma_secret_moves",
  {
    id: text().primaryKey(),
    /** The `secrets.stores` name the destination had when the move began. */
    destinationName: text().notNull(),
    sourceStore: text().notNull(),
    sourceNamespace: text().notNull(),
    destinationStore: text().notNull(),
    destinationNamespace: text().notNull(),
    phase: text().$type<MovePhase>().notNull(),
    fenced: boolean().notNull().default(false),
    retainHours: integer().notNull(),
    startedBy: text().notNull(),
    createdAt: when().notNull().defaultNow(),
    updatedAt: when()
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
    cutoverAt: when(),
    retainUntil: when(),
    retiredAt: when(),
  },
  (t) => [index("sanoma_secret_moves_source").on(t.sourceStore, t.sourceNamespace)],
).enableRLS();

/**
 * Each secret a move carries, by its logical name: where it is at both ends, what kind of value
 * it holds and its size, and the receipts: the source's version copied and the destination's
 * version written. Never a value, a hash of one or a provider message.
 */
export const secretMoveItems = pgTable(
  "sanoma_secret_move_items",
  {
    moveId: text().notNull(),
    name: text().notNull(),
    kind: text().$type<MoveItemKind>().notNull(),
    management: text().$type<"sanoma" | "external">().notNull(),
    sourcePath: text().notNull(),
    destinationPath: text().notNull(),
    bytes: integer(),
    /** What the move does with it: copy it, or leave it (external, bound outside the store, missing). */
    action: text().$type<MoveItemAction>().notNull(),
    /** The connections whose grant needs consent again at the destination, and why. */
    reauthorize: text().$type<"client_changed" | "client_missing">(),
    sourceVersion: text(),
    destinationVersion: text(),
    state: text().$type<MoveItemState>().notNull().default("pending"),
  },
  (t) => [primaryKey({ columns: [t.moveId, t.name] })],
).enableRLS();
