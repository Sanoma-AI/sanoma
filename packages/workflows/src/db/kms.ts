import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Envelope } from "../kms-secrets.ts";

// The KMS secret store's tables, in the schema `sanoma_kms` an administrator installs with
// `KMS_SECRETS_SQL` (`kms-secrets.ts`) and `sanoma.secretStore.prepare` (`storage-provisioning.ts`),
// with their grants: the runtime never makes them, so no migration is generated from this model.
// `installed-schemas.test.ts` holds the install SQL to it.

export const kms = pgSchema("sanoma_kms");

/** Each secret's envelope, by company, namespace and path. */
export const kmsSecrets = kms.table(
  "secrets",
  {
    company: text().notNull(),
    namespace: text().notNull(),
    path: text().notNull(),
    version: uuid().notNull(),
    envelope: jsonb().$type<Envelope>().notNull(),
    updatedBy: text().notNull(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.company, t.namespace, t.path] })],
);

/** The one row binding the database to its company and environment, and the runtime role's credential hash. */
export const kmsDeployment = kms.table(
  "deployment",
  {
    singleton: boolean().primaryKey().default(true),
    company: text().notNull(),
    environment: text().notNull(),
    runtimeRole: text().notNull(),
    credentialHash: text().notNull(),
  },
  (t) => [check("deployment_singleton", sql`${t.singleton}`)],
);
