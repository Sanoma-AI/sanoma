import type { UIMessage } from "ai";
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
import type { ConnectionHealth, ConnectionStatus } from "../connection.ts";
import type { LedgerRecord } from "../ledger.ts";
import type { SecretLocation } from "../secret-store.ts";

// The runtime's tables in a company's database, beside DBOS's: what `prepareDatabase` makes and
// every store reads. Column names are the property names in snake_case (`casing` in `db.ts` and
// in `drizzle/company.config.ts`). A change here is a new migration: `pnpm --filter
// @sanoma-ai/workflows generate` writes it under `drizzle/company/`, and CI refuses a schema
// whose migration was not generated.

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
);

/**
 * The Postgres ledger's records. `n` is the write order, `id` the record's, which the first write
 * of takes, and `seq` the record's place in its run: a run reads in `seq` order, then write order.
 */
export const ledger = pgTable(
  "sanoma_ledger",
  {
    n: bigserial({ mode: "number" }).primaryKey(),
    id: text().notNull().unique(),
    runId: text().notNull(),
    seq: integer().notNull(),
    record: jsonb().$type<LedgerRecord>().notNull(),
  },
  (t) => [index("sanoma_ledger_run_seq").on(t.runId, t.seq, t.n)],
);

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
);

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
);

/** The operator agent's chats (`chats.ts`): who each is for, its engine and its draft. */
export const chats = pgTable(
  "sanoma_chats",
  {
    id: text().primaryKey(),
    person: text().notNull(),
    engine: text().notNull(),
    draftId: text(),
    title: text().notNull(),
    createdAt: when().notNull().defaultNow(),
  },
  (t) => [index("sanoma_chats_person").on(t.person, t.createdAt)],
);

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
);

/** The api tokens (`tokens.ts`): each one's SHA-256, never the token, whom it acts for, its groups, and when it was revoked. */
export const apiTokens = pgTable("sanoma_api_tokens", {
  id: text().primaryKey(),
  hash: text().notNull().unique(),
  subject: text().notNull(),
  groups: jsonb().$type<string[]>().notNull(),
  createdAt: when().notNull().defaultNow(),
  revokedAt: when(),
});

/** The nonces of sealed invite requests spent (`spendInviteRequest`), each until it expires. */
export const inviteRequests = pgTable("sanoma_invite_requests", {
  nonce: text().primaryKey(),
  expiresAt: when().notNull(),
});

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
});

/** Each connection's last health check. */
export const connectionHealth = pgTable("sanoma_connection_health", {
  connectionId: text().primaryKey(),
  revision: text().notNull(),
  health: text().$type<ConnectionHealth["state"]>().notNull(),
  credentialVersion: text(),
  externallyRenewed: boolean().notNull(),
  checkedAt: when().notNull().defaultNow(),
});

/** The receipts of a connection's setup, one per revision. */
export const connectionSetups = pgTable(
  "sanoma_connection_setups",
  {
    connectionId: text().notNull(),
    revision: text().notNull(),
    credentialVersion: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.revision] })],
);
