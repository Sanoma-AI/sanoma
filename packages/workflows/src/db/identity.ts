import { sql } from "drizzle-orm";
import { bigint, boolean, check, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

// The cloud identity broker's tables, in the schema `sanoma_identity` an administrator installs
// with `CLOUD_IDENTITY_SQL` (`cloud-identity.ts`) and `CLOUD_IDENTITY_AUDIT_SQL`
// (`identity-service.ts`), with their grants: the runtime never makes them, so no migration is
// generated from this model. `cloud-identity-db.test.ts` holds the install SQL to it.

export const identity = pgSchema("sanoma_identity");

const when = () => timestamp({ withTimezone: true });

/** Each enrolled deployment and the service account it may act as. */
export const identityDeployments = identity.table("deployments", {
  id: text().primaryKey(),
  company: text().notNull(),
  environment: text().notNull(),
  serviceAccount: text().notNull(),
  enabled: boolean().notNull().default(true),
});

/** Each deployment credential's hash, never the credential, with its generation and validity. */
export const identityCredentials = identity.table(
  "credentials",
  {
    hash: text().primaryKey(),
    deployment: text()
      .notNull()
      .references(() => identityDeployments.id),
    generation: bigint({ mode: "number" }).notNull(),
    validFrom: when().notNull().defaultNow(),
    validUntil: when().notNull(),
    revoked: boolean().notNull().default(false),
  },
  (t) => [
    unique("credentials_deployment_generation").on(t.deployment, t.generation),
    check("credentials_hash", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check("credentials_generation", sql`${t.generation} > 0`),
    check("credentials_validity", sql`${t.validUntil} > ${t.validFrom}`),
    check("credentials_finite", sql`isfinite(${t.validFrom}) AND isfinite(${t.validUntil})`),
  ],
);

/** Each issuance decision, without token values. */
export const identityAuditEvents = identity.table(
  "audit_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    recordedAt: when()
      .notNull()
      .default(sql`clock_timestamp()`),
    result: text().$type<"issued" | "denied" | "unavailable">().notNull(),
    deployment: text(),
    company: text(),
    environment: text(),
    serviceAccount: text(),
    generation: bigint({ mode: "number" }),
    expiresAt: when(),
  },
  (t) => [check("audit_events_result", sql`${t.result} IN ('issued', 'denied', 'unavailable')`)],
);
