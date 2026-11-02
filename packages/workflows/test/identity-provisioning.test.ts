import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { useTestApp } from "@sanoma-ai/testing/harness";
import { lazyPool } from "../src/db.ts";
import { CLOUD_IDENTITY_SQL, createDeploymentCredential, postgresIdentityEnrollments } from "../src/cloud-identity.ts";
import { postgresIdentityProvisioning, memoryIdentityProvisioning } from "../src/identity-provisioning.ts";
import { defineWorkflow, memorySecretStore, sanoma } from "../src/index.ts";
import { z } from "zod";
import { Pool } from "pg";
import { runtimeDriver } from "../src/runtime-ops.ts";
import { memoryTokens } from "../src/tokens.ts";
import { memorySecrets } from "../src/secret.ts";
import { rootWith } from "./harness.ts";

const databaseUrl = testDatabaseUrl("identity_provisioning");
const pool = lazyPool(databaseUrl, "identity-provisioning-test");
const provision = postgresIdentityProvisioning(() => pool.db(), { maxValidityMs: 86_400_000 });
const reader = postgresIdentityEnrollments(() => pool.db());
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
  await db.query("DROP SCHEMA IF EXISTS sanoma_identity CASCADE");
  await db.query(CLOUD_IDENTITY_SQL);
});
afterAll(() => pool.close());

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
    expect(
      (await db.query("SELECT id FROM sanoma_identity.deployments WHERE id=$1", [other.deployment])).rowCount,
    ).toBe(0);
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
    expect(
      (
        await db.query("SELECT valid_until FROM sanoma_identity.credentials WHERE hash=$1", [old.hash])
      ).rows[0].valid_until.toISOString(),
    ).toBe(overlap);
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
    const role = `identity_reader_${randomUUID().replaceAll("-", "")}`;
    const restricted = new Pool({ connectionString: databaseUrl, options: `-c role=${role}` });
    try {
      await db.query(`CREATE ROLE ${role} NOLOGIN`);
      await db.query(`GRANT USAGE ON SCHEMA sanoma_identity TO ${role}`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA sanoma_identity TO ${role}`);
      const readOnly = postgresIdentityEnrollments(async () => restricted);
      const forbidden = postgresIdentityProvisioning(async () => restricted, { maxValidityMs: 86_400_000 });
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
      await db.query(`DROP OWNED BY ${role}`);
      await db.query(`DROP ROLE ${role}`);
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
      (await db.query("SELECT hash FROM sanoma_identity.credentials WHERE deployment=$1", [input.deployment])).rows,
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
      const history = JSON.stringify((await db.query(`SELECT row_to_json(t) FROM ${table} t`)).rows);
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
