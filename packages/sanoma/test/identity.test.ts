import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { Pool } from "pg";
import { CLOUD_IDENTITY_SQL } from "@sanoma-ai/workflows/cloud-identity";
import { CLOUD_IDENTITY_AUDIT_SQL } from "@sanoma-ai/workflows/identity-service";
import { ensureBuilt, runCli, serving } from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "sanoma-identity-command-"));
const databaseUrl = testDatabaseUrl("identity_cli");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.toString() });
const db = new Pool({ connectionString: databaseUrl });
const suffix = randomUUID().replaceAll("-", "");
const reader = `identity_cli_r_${suffix}`,
  audit = `identity_cli_a_${suffix}`;
const password = randomUUID();
const roleUrl = (role: string) => {
  const value = new URL(databaseUrl);
  value.username = role;
  value.password = password;
  return value.toString();
};
const env = {
  SANOMA_IDENTITY_MODE: "runtime",
  PORT: "0",
  SANOMA_IDENTITY_HOST: "127.0.0.1",
  SANOMA_IDENTITY_READ_DATABASE_URL: roleUrl(reader),
  SANOMA_IDENTITY_AUDIT_DATABASE_URL: roleUrl(audit),
};
beforeAll(async () => {
  await ensureBuilt();
  const name = new URL(databaseUrl).pathname.slice(1);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error("Invalid test database name");
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await db.query(CLOUD_IDENTITY_SQL + CLOUD_IDENTITY_AUDIT_SQL);
  for (const role of [reader, audit]) await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await db.query(`GRANT USAGE ON SCHEMA sanoma_identity TO ${reader}, ${audit};
    GRANT SELECT ON sanoma_identity.deployments, sanoma_identity.credentials TO ${reader};
    GRANT INSERT ON sanoma_identity.audit_events TO ${audit}`);
  // Neither these files nor a company worker should load in the trusted service process.
  writeFileSync(join(directory, "sanoma.config.ts"), 'throw new Error("company-code-must-not-load");');
  writeFileSync(join(directory, ".env"), "SANOMA_IDENTITY_MODE=invalid-from-company-file\n");
}, 120_000);
afterAll(async () => {
  for (const role of [reader, audit]) await db.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
  await db.end();
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

it("starts without loading company files and shuts down cleanly", async () => {
  const service = await serving(directory, ["identity"], env);
  try {
    expect((await fetch(service.url + "/health")).status).toBe(200);
    expect((await fetch(service.url + "/token", { method: "POST" })).status).toBe(401);
    expect((await fetch(service.url + "/workflows")).status).toBe(404);
    const output = JSON.stringify(service.output());
    expect(output).not.toContain(password);
    expect(output).not.toContain("company-code-must-not-load");
  } finally {
    expect(await service.stop()).not.toContain("company-code-must-not-load");
  }
});

it("requires explicit deployment credentials and reports only safe configuration errors", async () => {
  const result = await runCli(directory, ["identity"], { ...env, SANOMA_IDENTITY_READ_DATABASE_URL: "" });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Identity service requires SANOMA_IDENTITY_READ_DATABASE_URL");
  expect(result.stderr).not.toContain(password);
  const invalid = await runCli(directory, ["identity"], { ...env, SANOMA_IDENTITY_MODE: "sensitive-invalid-value" });
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("Invalid SANOMA_IDENTITY_MODE");
  expect(invalid.stderr).not.toContain("sensitive-invalid-value");
});
