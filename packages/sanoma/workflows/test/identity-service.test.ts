import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { testDatabaseUrl } from "sanoma/testing";
import { eq, sql } from "drizzle-orm";
import { escapeLiteral } from "pg";
import { lazyDb } from "../src/db.ts";
import { identityAuditEvents, identityCredentials, identityDeployments } from "../src/db/identity.ts";
import { CLOUD_IDENTITY_SQL, createDeploymentCredential, type ProvisioningIdentity } from "../src/cloud-identity.ts";
import { CLOUD_IDENTITY_AUDIT_SQL, startIdentityService } from "../src/identity-service.ts";

const url = testDatabaseUrl("identity_service");
const admin = lazyDb(url, "identity-service-test");
const suffix = randomUUID().replaceAll("-", "");
const readName = `identity_r_${suffix}`,
  auditName = `identity_a_${suffix}`;
const readRole = sql.identifier(readName),
  auditRole = sql.identifier(auditName);
const password = randomUUID();
const roleUrl = (role: string) => {
  const value = new URL(url);
  value.username = role;
  value.password = password;
  return value.toString();
};
const options = {
  enrollmentDatabaseUrl: roleUrl(readName),
  auditDatabaseUrl: roleUrl(auditName),
  mode: { type: "runtime" as const },
  host: "127.0.0.1",
  port: 0,
};
const credential = createDeploymentCredential();
const identity: ProvisioningIdentity = {
  serviceAccount: "provision-source@identity-project.iam.gserviceaccount.com",
  subject: "123456789012345678901",
  audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/provision/providers/google",
};
let issued = 0;
const transport = setupServer(
  http.get("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", () =>
    HttpResponse.json(
      { access_token: "synthetic-attached", expires_in: 3600, token_type: "Bearer" },
      { headers: { "Metadata-Flavor": "Google" } },
    ),
  ),
  http.post("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/:target", ({ params }) => {
    issued++;
    if (String(params.target).endsWith(":generateIdToken")) {
      const now = Math.floor(Date.now() / 1000);
      const token =
        [
          { alg: "RS256" },
          {
            iss: "https://accounts.google.com",
            sub: identity.subject,
            aud: identity.audience,
            email: identity.serviceAccount,
            email_verified: true,
            iat: now,
            exp: now + 3600,
          },
        ]
          .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
          .join(".") + ".syntheticSignature";
      return HttpResponse.json({ token });
    }
    return HttpResponse.json({
      accessToken: "synthetic-issued-token",
      expireTime: new Date(Date.now() + 600_000).toISOString(),
    });
  }),
);
beforeAll(async () => {
  const db = await admin.db();
  await db.execute(sql`DROP SCHEMA IF EXISTS sanoma_identity CASCADE`);
  await db.execute(sql.raw(CLOUD_IDENTITY_SQL + CLOUD_IDENTITY_AUDIT_SQL));
  for (const role of [readRole, auditRole])
    await db.execute(sql`CREATE ROLE ${role} LOGIN PASSWORD ${sql.raw(escapeLiteral(password))}`);
  await db.execute(sql`GRANT USAGE ON SCHEMA sanoma_identity TO ${readRole}, ${auditRole}`);
  await db.execute(sql`GRANT SELECT ON sanoma_identity.deployments, sanoma_identity.credentials TO ${readRole}`);
  await db.execute(sql`GRANT INSERT ON sanoma_identity.audit_events TO ${auditRole}`);
  await db.insert(identityDeployments).values({
    id: "control",
    company: "sanoma",
    environment: "production",
    serviceAccount: identity.serviceAccount,
  });
  await db.insert(identityCredentials).values({
    hash: credential.hash,
    deployment: "control",
    generation: 1,
    validFrom: sql`now()`,
    validUntil: sql`now() + interval '1 hour'`,
  });
  transport.listen({ onUnhandledFrame: "bypass" });
});
afterAll(async () => {
  transport.close();
  const db = await admin.db();
  for (const role of [readRole, auditRole]) {
    await db.execute(sql`DROP OWNED BY ${role}`);
    await db.execute(sql`DROP ROLE ${role}`);
  }
  await admin.close();
});

it("serves the runtime route with read-only enrollment and append-only audit roles", async () => {
  const service = await startIdentityService(options);
  try {
    expect((await fetch(service.url + "/health")).status).toBe(200);
    expect((await fetch(service.url + "/healthz")).status).toBe(200);
    expect((await fetch(service.url + "/token", { method: "POST" })).status).toBe(401);
    const response = await fetch(service.url + "/token", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.credential}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accessToken: "synthetic-issued-token" });
    expect((await fetch(service.url + "/identity")).status).toBe(404);
    const events = await (await admin.db()).select().from(identityAuditEvents).orderBy(identityAuditEvents.recordedAt);
    expect(events.map((e) => e.result)).toEqual(["denied", "issued"]);
    const text = JSON.stringify(events);
    for (const secret of [
      credential.credential,
      credential.hash,
      "synthetic-issued-token",
      "synthetic-attached",
      password,
    ])
      expect(text).not.toContain(secret);
  } finally {
    await service.stop();
    await service.stop();
  }
});

it("refuses writer/admin enrollment and audit roles with read or mutation privileges", async () => {
  await expect(startIdentityService({ ...options, enrollmentDatabaseUrl: url })).rejects.toThrow(
    "Identity service unavailable",
  );
  await expect(startIdentityService({ ...options, auditDatabaseUrl: url })).rejects.toThrow(
    "Identity service unavailable",
  );
  const db = await admin.db();
  await db.execute(sql`GRANT SELECT ON sanoma_identity.audit_events TO ${auditRole}`);
  try {
    await expect(startIdentityService(options)).rejects.toThrow("Identity service unavailable");
  } finally {
    await db.execute(sql`REVOKE SELECT ON sanoma_identity.audit_events FROM ${auditRole}`);
  }
});

it("fails closed during audit outage and recovers without a fallback identity", async () => {
  const service = await startIdentityService(options);
  const db = await admin.db();
  const call = () =>
    fetch(service.url + "/token", { method: "POST", headers: { Authorization: `Bearer ${credential.credential}` } });
  try {
    await db.execute(sql`REVOKE INSERT ON sanoma_identity.audit_events FROM ${auditRole}`);
    const denied = await call();
    expect(denied.status).toBe(503);
    expect(await denied.text()).toBe('{"error":"unavailable"}');
    await db.execute(sql`GRANT INSERT ON sanoma_identity.audit_events TO ${auditRole}`);
    expect((await call()).status).toBe(200);
  } finally {
    await db.execute(sql`GRANT INSERT ON sanoma_identity.audit_events TO ${auditRole}`);
    await service.stop();
  }
});

it("bounds in-flight issuance and resumes after overload without returning another token", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  transport.use(
    http.post("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/:target", async () => {
      entered = true;
      await gate;
      return HttpResponse.json({
        accessToken: "synthetic-issued-token",
        expireTime: new Date(Date.now() + 600_000).toISOString(),
      });
    }),
  );
  const service = await startIdentityService({ ...options, maxConcurrentRequests: 1 });
  const call = () =>
    fetch(service.url + "/token", { method: "POST", headers: { Authorization: `Bearer ${credential.credential}` } });
  const first = call();
  try {
    await expect.poll(() => entered).toBe(true);
    const busy = await call();
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(await busy.text()).toBe('{"error":"busy"}');
    release();
    expect((await first).status).toBe(200);
    expect((await call()).status).toBe(200);
  } finally {
    release();
    await first;
    await service.stop();
    transport.resetHandlers();
  }
});

it("serves only the fixed provisioning route and rejects GET bodies at the HTTP boundary", async () => {
  const service = await startIdentityService({ ...options, mode: { type: "provisioning", identity } });
  try {
    const headers = { Authorization: `Bearer ${credential.credential}` };
    const response = await fetch(service.url + "/identity", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idToken: expect.stringContaining("syntheticSignature") });
    expect((await fetch(service.url + "/token", { method: "POST", headers })).status).toBe(404);
    const count = issued;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        service.url + "/identity",
        { method: "GET", headers: { ...headers, "Content-Length": "2" } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(400);
    expect(issued).toBe(count);
    await (
      await admin.db()
    )
      .update(identityDeployments)
      .set({ enabled: false })
      .where(eq(identityDeployments.id, "control"));
    expect((await fetch(service.url + "/identity", { headers })).status).toBe(401);
    expect(issued).toBe(count);
  } finally {
    await service.stop();
  }
});
