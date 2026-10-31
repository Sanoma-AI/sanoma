import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { lazyPool } from "../src/db.ts";
import { CLOUD_IDENTITY_SQL, createDeploymentCredential, postgresIdentityEnrollments } from "../src/cloud-identity.ts";

const pool = lazyPool(testDatabaseUrl("identity_broker"), "identity-broker-tests");
afterAll(() => pool.close());

it("persists hash-only generations, bounds overlap, and gives the broker no enrollment mutation authority", async () => {
  const db = await pool.db();
  // This file has its own task-isolated database; rebuild only its broker test schema.
  await db.query("DROP SCHEMA IF EXISTS sanoma_identity CASCADE");
  await db.query(CLOUD_IDENTITY_SQL);
  const id = `deployment-${randomUUID()}`;
  const reader = `identity_reader_${randomUUID().replaceAll("-", "")}`;
  const old = createDeploymentCredential(),
    next = createDeploymentCredential();
  await db.query(`CREATE ROLE ${reader} NOLOGIN`);
  const connection = await db.connect();
  try {
    await db.query(`GRANT USAGE ON SCHEMA sanoma_identity TO ${reader}`);
    await db.query(`GRANT SELECT ON sanoma_identity.deployments, sanoma_identity.credentials TO ${reader}`);
    await db.query(
      "INSERT INTO sanoma_identity.deployments(id,company,environment,service_account) VALUES ($1,'company-a','production','runtime@identity-project.iam.gserviceaccount.com')",
      [id],
    );
    await db.query(
      "INSERT INTO sanoma_identity.credentials(hash,deployment,generation,valid_until) VALUES ($1,$3,1,clock_timestamp() + interval '1 hour'),($2,$3,2,clock_timestamp() + interval '2 hours')",
      [old.hash, next.hash, id],
    );
    await expect(
      db.query("UPDATE sanoma_identity.credentials SET valid_until='infinity' WHERE hash=$1", [old.hash]),
    ).rejects.toMatchObject({ code: "23514" });
    await connection.query(`SET ROLE ${reader}`);
    const store = postgresIdentityEnrollments(async () => connection);
    expect(await store.active(old.hash)).toMatchObject({ deployment: id, generation: 1, company: "company-a" });
    expect(await store.active(next.hash)).toMatchObject({ deployment: id, generation: 2 });
    expect(await store.active(old.credential)).toBeUndefined();
    await expect(
      connection.query("UPDATE sanoma_identity.deployments SET company = 'company-b' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection.query("DELETE FROM sanoma_identity.credentials WHERE deployment = $1", [id]),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query("UPDATE sanoma_identity.credentials SET revoked=true WHERE hash=$1", [old.hash]);
    expect(await store.active(old.hash)).toBeUndefined();
    expect(await store.active(next.hash)).toBeDefined();
    await db.query(
      "UPDATE sanoma_identity.credentials SET valid_from=clock_timestamp()-interval '2 hours',valid_until=clock_timestamp()-interval '1 hour' WHERE hash=$1",
      [next.hash],
    );
    expect(await store.active(next.hash)).toBeUndefined();
    await db.query(
      "UPDATE sanoma_identity.credentials SET valid_until=clock_timestamp()+interval '1 hour' WHERE hash=$1",
      [next.hash],
    );
    await db.query("UPDATE sanoma_identity.deployments SET enabled=false WHERE id=$1", [id]);
    expect(await store.active(next.hash)).toBeUndefined();
  } finally {
    await connection.query("RESET ROLE");
    connection.release();
    await db.query("DELETE FROM sanoma_identity.credentials WHERE deployment=$1", [id]);
    await db.query("DELETE FROM sanoma_identity.deployments WHERE id=$1", [id]);
    await db.query(`DROP OWNED BY ${reader}`);
    await db.query(`DROP ROLE ${reader}`);
  }
});
