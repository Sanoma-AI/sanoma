import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { databaseOn, lazyDb } from "../src/db.ts";
import { identityCredentials, identityDeployments } from "../src/db/identity.ts";
import { CLOUD_IDENTITY_SQL, createDeploymentCredential, postgresIdentityEnrollments } from "../src/cloud-identity.ts";
import {
  postgresIdentityProvisioning,
  memoryIdentityProvisioning,
  configuredIdentityProvisioning,
} from "../src/identity-provisioning.ts";
import { defineWorkflow, memorySecretStore, sanoma } from "../src/index.ts";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { Pool, escapeLiteral } from "pg";
import { describeConfig } from "../src/describe.ts";
import { runtimeDriver } from "../src/runtime-ops.ts";
import { memoryTokens } from "../src/tokens.ts";
import { memorySecrets } from "../src/secret.ts";
import { rootWith } from "./harness.ts";

const databaseUrl = testDatabaseUrl("identity_provisioning");
const pool = lazyDb(databaseUrl, "identity-provisioning-test");
const provision = postgresIdentityProvisioning(() => pool.db(), { maxValidityMs: 86_400_000 });
const reader = postgresIdentityEnrollments(() => pool.db());
const writerName = `identity_writer_${randomUUID().replaceAll("-", "")}`;
const writerRole = sql.identifier(writerName);
const writerUrl = new URL(databaseUrl);
writerUrl.username = writerName;
writerUrl.password = randomUUID();
const identity = () => ({
  deployment: randomUUID(),
  company: "company-a",
  environment: "production",
  serviceAccount: "runtime-a@identity-project.iam.gserviceaccount.com",
});
const enrollment = () => ({
  ...identity(),
  generation: 1,
  hash: createDeploymentCredential().hash,
  validUntil: new Date(Date.now() + 3_600_000).toISOString(),
});
beforeAll(async () => {
  const db = await pool.db();
  await db.execute(sql`DROP SCHEMA IF EXISTS sanoma_identity CASCADE`);
  await db.execute(sql.raw(CLOUD_IDENTITY_SQL));
  await db.execute(
    sql`CREATE ROLE ${writerRole} LOGIN PASSWORD ${sql.raw(escapeLiteral(writerUrl.password))} NOINHERIT`,
  );
  await db.execute(sql`GRANT CONNECT ON DATABASE ${sql.identifier(writerUrl.pathname.slice(1))} TO ${writerRole}`);
  await db.execute(sql`GRANT USAGE ON SCHEMA sanoma_identity TO ${writerRole}`);
  await db.execute(
    sql`GRANT SELECT, INSERT, UPDATE ON sanoma_identity.deployments, sanoma_identity.credentials TO ${writerRole}`,
  );
});
afterAll(async () => {
  const db = await pool.db();
  await db.execute(sql`DROP OWNED BY ${writerRole}`);
  await db.execute(sql`DROP ROLE ${writerRole}`);
  await pool.close();
});

describe("declarative enrollment writer", () => {
  it("describes and closes unused config without I/O, and sanitizes invalid URLs", async () => {
    const connect = vi.spyOn(Pool.prototype, "connect");
    try {
      const config = { databaseUrl: writerUrl.href, maxValidityMs: 86_400_000 };
      expect(JSON.stringify(describeConfig({ connectors: [], identityProvisioning: config }))).not.toContain(
        writerUrl.href,
      );
      await configuredIdentityProvisioning(config).close();
      expect(connect).not.toHaveBeenCalled();
      expect(() => configuredIdentityProvisioning({ ...config, databaseUrl: "sensitive-invalid-value" })).toThrow(
        "Identity provisioning: invalid",
      );
    } finally {
      connect.mockRestore();
    }
  });

  it("uses a restricted writer, denies privilege drift and closes its own pool", async () => {
    const configured = configuredIdentityProvisioning({ databaseUrl: writerUrl.href, maxValidityMs: 86_400_000 });
    const input = enrollment();
    try {
      await configured.store!.enroll(input);
      expect(await reader.active(input.hash)).toBeDefined();
      const db = await pool.db();
      await db.execute(sql`REVOKE UPDATE ON sanoma_identity.credentials FROM ${writerRole}`);
      try {
        await expect(configured.store!.enroll(enrollment())).rejects.toMatchObject({ code: "invalid" });
      } finally {
        await db.execute(sql`GRANT UPDATE ON sanoma_identity.credentials TO ${writerRole}`);
      }
      await configured.store!.revoke(input);
      expect(await reader.active(input.hash)).toBeUndefined();
    } finally {
      await configured.close();
    }
    await configured.close();
    await expect(configured.store!.enroll(enrollment())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects an administrator writer and leaves caller-supplied adapters owned by the caller", async () => {
    const admin = configuredIdentityProvisioning({ databaseUrl, maxValidityMs: 86_400_000 });
    try {
      await expect(admin.store!.enroll(enrollment())).rejects.toMatchObject({ code: "invalid" });
    } finally {
      await admin.close();
    }
    const adapter = memoryIdentityProvisioning(),
      close = vi.fn<() => Promise<void>>();
    await configuredIdentityProvisioning({ ...adapter, close } as typeof adapter).close();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("transactional enrollment authority", () => {
  it("enrolls an exact immutable mapping idempotently and rejects rebinding or hash reuse", async () => {
    const input = enrollment();
    await Promise.all([provision.enroll(input), provision.enroll(input)]);
    expect(await reader.active(input.hash)).toMatchObject({ deployment: input.deployment, generation: 1 });
    for (const override of [
      { company: "company-b" },
      { environment: "preview" },
      { serviceAccount: "runtime-b@identity-project.iam.gserviceaccount.com" },
      { hash: createDeploymentCredential().hash },
    ]) {
      await expect(provision.enroll({ ...input, ...override })).rejects.toMatchObject({ code: "conflict" });
    }
    const other = { ...input, deployment: randomUUID() };
    await expect(provision.enroll(other)).rejects.toMatchObject({ code: "conflict" });
    const db = await pool.db();
    // Failed enrollment rolled back its new mapping as well as its credential.
    expect(await db.select().from(identityDeployments).where(eq(identityDeployments.id, other.deployment))).toEqual([]);
  });

  it("rotates, bounds overlap, and never restores retired access on retry", async () => {
    const old = enrollment();
    const next = { ...old, generation: 2, hash: createDeploymentCredential().hash };
    await provision.enroll(old);
    await provision.enroll(next);
    expect(await reader.active(old.hash)).toBeDefined();
    expect(await reader.active(next.hash)).toBeDefined();
    const overlap = new Date(Date.now() + 60_000).toISOString();
    await provision.retire({ ...old, validUntil: overlap });
    await provision.retire(old); // Later deadline cannot extend access.
    const db = await pool.db();
    const [retired] = await db
      .select({ validUntil: identityCredentials.validUntil })
      .from(identityCredentials)
      .where(eq(identityCredentials.hash, old.hash));
    expect(retired!.validUntil.toISOString()).toBe(overlap);
    await expect(provision.enroll(old)).rejects.toMatchObject({ code: "conflict" });
    await provision.retire({ ...old, validUntil: new Date(0).toISOString() });
    expect(await reader.active(old.hash)).toBeUndefined();
    expect(await reader.active(next.hash)).toBeDefined();
    await expect(provision.enroll({ ...next, generation: 1 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("serializes revocation with new generations and keeps revocation terminal", async () => {
    const old = enrollment();
    await provision.enroll(old);
    const next = { ...old, generation: 2, hash: createDeploymentCredential().hash };
    await Promise.allSettled([provision.enroll(next), provision.revoke(old)]);
    expect(await reader.active(old.hash)).toBeUndefined();
    expect(await reader.active(next.hash)).toBeUndefined();
    await provision.revoke(old);
    await expect(provision.enroll(old)).rejects.toMatchObject({ code: "conflict" });
    await expect(provision.enroll({ ...next, generation: 3 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses wrong-owner mutations and invalid validity without creating a mapping", async () => {
    const input = enrollment();
    await provision.enroll(input);
    await expect(provision.revoke({ ...input, company: "company-b" })).rejects.toMatchObject({ code: "conflict" });
    await expect(provision.retire({ ...input, environment: "preview" })).rejects.toMatchObject({ code: "conflict" });
    expect(await reader.active(input.hash)).toBeDefined();
    for (const validUntil of [
      new Date(0).toISOString(),
      "infinity",
      new Date(Date.now() + 2 * 86_400_000).toISOString(),
    ]) {
      const invalid = { ...enrollment(), validUntil };
      await expect(provision.enroll(invalid)).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("sanitizes database failures", async () => {
    const broken = postgresIdentityProvisioning(
      async () => {
        throw new Error("synthetic-database-password");
      },
      { maxValidityMs: 1000 },
    );
    await expect(broken.enroll(enrollment())).rejects.toMatchObject({
      message: "Identity provisioning: unavailable",
      retryable: true,
    });
  });

  it("lets a broker role read but refuses every enrollment mutation", async () => {
    const input = enrollment();
    await provision.enroll(input);
    const db = await pool.db();
    const roleName = `identity_reader_${randomUUID().replaceAll("-", "")}`;
    const role = sql.identifier(roleName);
    const restricted = new Pool({ connectionString: databaseUrl, options: `-c role=${roleName}` });
    try {
      await db.execute(sql`CREATE ROLE ${role} NOLOGIN`);
      await db.execute(sql`GRANT USAGE ON SCHEMA sanoma_identity TO ${role}`);
      await db.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA sanoma_identity TO ${role}`);
      const readOnly = postgresIdentityEnrollments(async () => databaseOn(restricted));
      const forbidden = postgresIdentityProvisioning(async () => databaseOn(restricted), { maxValidityMs: 86_400_000 });
      expect(await readOnly.active(input.hash)).toMatchObject({ deployment: input.deployment });
      for (const write of [
        () => forbidden.enroll({ ...input, generation: 2, hash: createDeploymentCredential().hash }),
        () => forbidden.retire({ ...input, validUntil: new Date(0).toISOString() }),
        () => forbidden.revoke(input),
      ]) {
        await expect(write()).rejects.toMatchObject({ message: "Identity provisioning: unavailable" });
        expect(await reader.active(input.hash)).toBeDefined();
      }
    } finally {
      await restricted.end();
      await db.execute(sql`DROP OWNED BY ${role}`);
      await db.execute(sql`DROP ROLE ${role}`);
    }
  });

  it("retries a lost commit response with the original stored bearer and sanitizes backend errors", async () => {
    let loseResponse = true;
    const input = { ...enrollment(), store: "LOST_RESPONSE_BOOTSTRAP" };
    const secrets = memorySecrets();
    const driver = runtimeDriver({
      tokens: memoryTokens(),
      identities: {
        ...provision,
        async enroll(request) {
          await provision.enroll(request);
          if (loseResponse) {
            loseResponse = false;
            throw new Error(`lost-response-with-sensitive-hash:${request.hash}`);
          }
        },
      },
    });
    const call = {
      idempotencyKey: "identity:1",
      runId: "identity",
      opId: "sanoma.identity.enroll",
      attempt: 1,
      secrets,
    };
    const failure = await driver.ops["identity.enroll"]!(input, call).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "Identity provisioning: unavailable",
      retryable: true,
    });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain("lost-response-with-sensitive-hash");
    const bearer = await secrets.get(input.store);
    expect(bearer).toBeDefined();
    const hash = createHash("sha256").update(bearer!).digest("hex");
    expect(await reader.active(hash)).toBeDefined();
    expect(await driver.ops["identity.enroll"]!(input, { ...call, attempt: 2 })).toEqual({
      deployment: input.deployment,
      generation: 1,
      store: input.store,
    });
    expect(await secrets.get(input.store)).toBe(bearer);
    const db = await pool.db();
    expect(
      await db
        .select({ hash: identityCredentials.hash })
        .from(identityCredentials)
        .where(eq(identityCredentials.deployment, input.deployment)),
    ).toEqual([{ hash }]);
  });

  it("preserves only fixed error codes from another package copy", async () => {
    const driver = runtimeDriver({
      tokens: memoryTokens(),
      identities: {
        ...provision,
        async revoke() {
          throw { name: "IdentityProvisioningError", code: "conflict", message: "synthetic-sensitive-value" };
        },
      },
    });
    await expect(
      driver.ops["identity.revoke"]!(identity(), {
        idempotencyKey: "identity:2",
        runId: "identity",
        opId: "sanoma.identity.revoke",
        attempt: 1,
        secrets: memorySecrets(),
      }),
    ).rejects.toMatchObject({ message: "Identity provisioning: conflict", retryable: false });
  });

  it("uses independent run-local authority in sandbox", async () => {
    const one = memoryIdentityProvisioning(),
      two = memoryIdentityProvisioning();
    const input = enrollment();
    await one.enroll(input);
    await one.revoke(input);
    await expect(one.enroll(input)).rejects.toMatchObject({ code: "conflict" });
    await two.enroll(input);
    expect(await reader.active(input.hash)).toBeUndefined();
  });
});

const enroll = defineWorkflow({
  name: "identity-enroll",
  trigger: "manual",
  input: z.object({
    deployment: z.string(),
    company: z.string(),
    store: z.string(),
    generation: z.number(),
    validUntil: z.string(),
  }),
  uses: [sanoma.identity.enroll],
  run: async (ctx, input) =>
    await ctx.sanoma.identity.enroll({
      ...input,
      environment: "production",
      serviceAccount: "runtime-a@identity-project.iam.gserviceaccount.com",
    }),
});
const revoke = defineWorkflow({
  name: "identity-revoke",
  trigger: "manual",
  input: z.object({ deployment: z.string() }),
  uses: [sanoma.identity.revoke],
  run: async (ctx, input) =>
    await ctx.sanoma.identity.revoke({
      ...input,
      company: "company-a",
      environment: "production",
      serviceAccount: "runtime-a@identity-project.iam.gserviceaccount.com",
    }),
});

describe("built-in workflow operations", () => {
  const store = memorySecretStore();
  const committed = new Set<string>();
  const root = rootWith({
    "policies/identity.cedar": `
forbid(principal, action == Sanoma::Action::"sanoma.identity.enroll", resource)
when { context.input.company == "company-b" };
`,
  });
  const app = useTestApp(
    {
      connectors: [],
      workflows: [enroll, revoke],
      secrets: { store },
      identityProvisioning: {
        ...provision,
        async enroll(input) {
          await provision.enroll(input);
          if (!committed.has(input.deployment)) {
            committed.add(input.deployment);
            // Force a durable retry after an uncertain commit, including a sensitive backend error.
            throw new Error(`sensitive-enrollment:${input.hash}`);
          }
        },
      },
      root,
    },
    { databaseUrl },
  );
  it("enrolls and revokes under policy without capturing the bearer in durable history", async () => {
    const input = {
      deployment: randomUUID(),
      company: "company-a",
      store: "COMPANY_A_BOOTSTRAP",
      generation: 1,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const run = await app.client.start(enroll.name, input, { startedBy: "ada" });
    expect(await app.client.result(run)).toEqual({ deployment: input.deployment, generation: 1, store: input.store });
    expect(committed.has(input.deployment)).toBe(true);
    const value = (await store.read({ namespace: "default", path: input.store }))!.value;
    const hash = createHash("sha256").update(value).digest("hex");
    expect(await reader.active(hash)).toMatchObject({ deployment: input.deployment, company: "company-a" });
    const ledger = JSON.stringify(await app.client.ledger(run));
    expect(ledger).toContain("sanoma.identity.enroll");
    expect(ledger).not.toContain(value);
    expect(ledger).not.toContain(hash);
    const db = await pool.db();
    for (const table of ["dbos.operation_outputs", "dbos.workflow_status"]) {
      const history = JSON.stringify((await db.execute(sql`SELECT row_to_json(t) FROM ${sql.raw(table)} t`)).rows);
      expect(history).not.toContain(value);
      expect(history).not.toContain(hash);
      expect(history).not.toContain("sensitive-enrollment:");
    }
    const denied = await app.client.start(
      enroll.name,
      { ...input, deployment: randomUUID(), company: "company-b", store: "COMPANY_B_BOOTSTRAP" },
      { startedBy: "ada" },
    );
    await expect(app.client.result(denied)).rejects.toMatchObject({ code: "policy_denied" });
    expect(await store.read({ namespace: "default", path: "COMPANY_B_BOOTSTRAP" })).toBeUndefined();
    await app.client.result(
      await app.client.start(revoke.name, { deployment: input.deployment }, { startedBy: "ada" }),
    );
    expect(await reader.active(hash)).toBeUndefined();
  });

  it("refuses direct enrollment before creating a secret", async () => {
    await expect(
      app.client.call(
        "sanoma.identity.enroll",
        {
          ...enrollment(),
          store: "DIRECT_BOOTSTRAP",
        },
        { actor: "ada" },
      ),
    ).rejects.toThrow(/cannot be called directly/);
    expect(await store.read({ namespace: "default", path: "DIRECT_BOOTSTRAP" })).toBeUndefined();
  });
});

describe("runtime-owned enrollment connection", () => {
  const store = memorySecretStore();
  const app = useTestApp(
    {
      connectors: [],
      workflows: [enroll, revoke],
      secrets: { store },
      identityProvisioning: { databaseUrl: writerUrl.href, maxValidityMs: 86_400_000 },
    },
    { databaseUrl: testDatabaseUrl("identity_config_runtime") },
  );
  it("enrolls through the configured dedicated database rather than the company runtime database", async () => {
    const input = {
      deployment: randomUUID(),
      company: "company-a",
      store: "CONFIGURED_BOOTSTRAP",
      generation: 1,
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await app.client.result(await app.client.start(enroll, input, { startedBy: "ada" }));
    const bearer = (await store.read({ namespace: "default", path: input.store }))!.value;
    const hash = createHash("sha256").update(bearer).digest("hex");
    expect(await reader.active(hash)).toMatchObject({ deployment: input.deployment });
    await app.stop();
    // pg-pool resolves end() after removing idle clients from its list, before their
    // asynchronous socket shutdown necessarily disappears from the server's view.
    // A leaked writer must still fail; wait only for the server to observe shutdown.
    await expect
      .poll(
        async () => {
          const { rows } = await (
            await pool.db()
          ).execute<{ count: number }>(
            sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename=${writerName}`,
          );
          return rows[0]!.count;
        },
        { timeout: 5_000, interval: 50 },
      )
      .toBe(0);
  });
});
