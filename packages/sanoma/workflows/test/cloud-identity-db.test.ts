import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, expect, it } from "vitest";
import { testDatabaseUrl } from "sanoma/testing";
import { databaseOn, lazyDb } from "../src/db.ts";
import { identityCredentials, identityDeployments } from "../src/db/identity.ts";
import { CLOUD_IDENTITY_SQL, createDeploymentCredential, postgresIdentityEnrollments } from "../src/cloud-identity.ts";

const url = testDatabaseUrl("identity_broker");
const hour = (hours: number) => sql`clock_timestamp() + ${`${hours} hours`}::interval`;
const pool = lazyDb(url, "identity-broker-tests");
afterAll(() => pool.close());

it("persists hash-only generations, bounds overlap, and gives the broker no enrollment mutation authority", async () => {
  const db = await pool.db();
  // This file has its own task-isolated database; rebuild only its broker test schema.
  await db.execute(sql`DROP SCHEMA IF EXISTS sanoma_identity CASCADE`);
  await db.execute(sql.raw(CLOUD_IDENTITY_SQL));
  const id = `deployment-${randomUUID()}`;
  const reader = sql.identifier(`identity_reader_${randomUUID().replaceAll("-", "")}`);
  const old = createDeploymentCredential(),
    next = createDeploymentCredential();
  await db.execute(sql`CREATE ROLE ${reader} NOLOGIN`);
  const client = new Client({ connectionString: url });
  await client.connect();
  const connection = databaseOn(client);
  try {
    await db.execute(sql`GRANT USAGE ON SCHEMA sanoma_identity TO ${reader}`);
    await db.execute(sql`GRANT SELECT ON sanoma_identity.deployments, sanoma_identity.credentials TO ${reader}`);
    await db.insert(identityDeployments).values({
      id,
      company: "company-a",
      environment: "production",
      serviceAccount: "runtime@identity-project.iam.gserviceaccount.com",
    });
    await db.insert(identityCredentials).values([
      { hash: old.hash, deployment: id, generation: 1, validUntil: hour(1) },
      { hash: next.hash, deployment: id, generation: 2, validUntil: hour(2) },
    ]);
    await expect(
      db
        .update(identityCredentials)
        .set({ validUntil: sql`'infinity'` })
        .where(eq(identityCredentials.hash, old.hash)),
    ).rejects.toMatchObject({ code: "23514" });
    await connection.execute(sql`SET ROLE ${reader}`);
    const store = postgresIdentityEnrollments(async () => connection);
    expect(await store.active(old.hash)).toMatchObject({ deployment: id, generation: 1, company: "company-a" });
    expect(await store.active(next.hash)).toMatchObject({ deployment: id, generation: 2 });
    expect(await store.active(old.credential)).toBeUndefined();
    await expect(
      connection.update(identityDeployments).set({ company: "company-b" }).where(eq(identityDeployments.id, id)),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection.delete(identityCredentials).where(eq(identityCredentials.deployment, id)),
    ).rejects.toMatchObject({ code: "42501" });
    await db.update(identityCredentials).set({ revoked: true }).where(eq(identityCredentials.hash, old.hash));
    expect(await store.active(old.hash)).toBeUndefined();
    expect(await store.active(next.hash)).toBeDefined();
    await db
      .update(identityCredentials)
      .set({ validFrom: hour(-2), validUntil: hour(-1) })
      .where(eq(identityCredentials.hash, next.hash));
    expect(await store.active(next.hash)).toBeUndefined();
    await db
      .update(identityCredentials)
      .set({ validUntil: hour(1) })
      .where(eq(identityCredentials.hash, next.hash));
    await db.update(identityDeployments).set({ enabled: false }).where(eq(identityDeployments.id, id));
    expect(await store.active(next.hash)).toBeUndefined();
  } finally {
    await connection.execute(sql`RESET ROLE`);
    await client.end();
    await db.delete(identityCredentials).where(eq(identityCredentials.deployment, id));
    await db.delete(identityDeployments).where(eq(identityDeployments.id, id));
    await db.execute(sql`DROP OWNED BY ${reader}`);
    await db.execute(sql`DROP ROLE ${reader}`);
  }
});
