import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { Client, escapeIdentifier, escapeLiteral } from "pg";
import { KMS_SECRETS_SQL } from "./kms-secrets.ts";
import { generateSecret, type Secrets } from "./secret.ts";

export interface PrepareSecretStore {
  company: string;
  environment: string;
  database: { $secret: string };
  store: string;
}
export interface PreparedSecretStore {
  company: string;
  environment: string;
  role: string;
  store: string;
}
export type PrepareStorage = (input: PrepareSecretStore, secrets: Secrets) => Promise<PreparedSecretStore>;

export class StorageProvisioningError extends Error {
  readonly code: "invalid" | "conflict" | "denied" | "unavailable";
  constructor(code: StorageProvisioningError["code"]) {
    super(`Storage provisioning: ${code}`);
    this.name = "StorageProvisioningError";
    this.code = code;
  }
}
export function storageProvisioningCode(error: unknown): StorageProvisioningError["code"] | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    !("name" in error) ||
    error.name !== "StorageProvisioningError" ||
    !("code" in error)
  )
    return;
  switch (error.code) {
    case "invalid":
    case "conflict":
    case "denied":
    case "unavailable":
      return error.code;
  }
}
const fail = (code: StorageProvisioningError["code"]): never => {
  throw new StorageProvisioningError(code);
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ROLE_PREFIX = "sanoma_runtime_";
const BINDING_SQL = `CREATE TABLE IF NOT EXISTS sanoma_kms.deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  company text NOT NULL, environment text NOT NULL, runtime_role text NOT NULL,
  credential_hash text NOT NULL
);
REVOKE ALL ON sanoma_kms.deployment FROM PUBLIC;`;

/** A verifier, not the login password, appears in the SQL sent to Postgres. */
function verifier(password: string): string {
  const salt = randomBytes(16),
    salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  try {
    const stored = createHash("sha256").update(client).digest("base64");
    const server = createHmac("sha256", salted).update("Server Key").digest("base64");
    return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
  } finally {
    salted.fill(0);
    client.fill(0);
  }
}

async function credentials(input: PrepareSecretStore, secrets: Secrets) {
  if (
    ![input.company, input.environment].every(
      (v) => typeof v === "string" && v.length > 0 && v.length <= 256 && !v.includes("\0"),
    ) ||
    !/^[A-Z][A-Z0-9_]*$/.test(input.database.$secret) ||
    !/^[A-Z][A-Z0-9_]*$/.test(input.store) ||
    input.store.startsWith("SANOMA_") ||
    input.store === input.database.$secret
  )
    fail("invalid");
  const source = await secrets.get(input.database.$secret);
  if (!source) return fail("invalid");
  let admin: URL;
  try {
    admin = new URL(source);
  } catch {
    return fail("invalid");
  }
  if (
    !["postgres:", "postgresql:"].includes(admin.protocol) ||
    !admin.hostname ||
    !admin.username ||
    !admin.password ||
    !/^\/[^/]+$/.test(admin.pathname) ||
    ["postgres", "template0", "template1"].includes(decodeURIComponent(admin.pathname.slice(1))) ||
    admin.hash ||
    [...admin.searchParams.keys()].some((key) => !["sslmode", "channel_binding"].includes(key))
  )
    fail("invalid");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(admin.hostname)) admin.searchParams.set("sslmode", "verify-full");
  const role = `${ROLE_PREFIX}${digest(JSON.stringify([input.company, input.environment])).slice(0, 24)}`;
  const expected = new URL(admin);
  expected.username = role;
  expected.password = "";
  // Persist before any database mutation: retries after a lost response retain the same password.
  const value = await secrets.ensure(input.store, () => {
    const generated = new URL(expected);
    generated.password = generateSecret();
    return generated.href;
  });
  let runtime: URL;
  try {
    runtime = new URL(value);
  } catch {
    return fail("conflict");
  }
  const password = runtime.password;
  runtime.password = "";
  if (runtime.href !== expected.href || !/^[A-Za-z0-9_-]{43}$/.test(password)) fail("conflict");
  return {
    admin: admin.href,
    runtime: value,
    role,
    password,
    receipt: { company: input.company, environment: input.environment, role, store: input.store },
  };
}

async function connected<T>(url: string, run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  db.on("error", () => {
    /* Never log database credentials or SQL diagnostics. */
  });
  try {
    await db.connect();
    return await run(db);
  } finally {
    await db.end().catch(() => {});
  }
}

/** Privileged, company-scoped preparation only; no credential values escape this trusted boundary. */
export const prepareSecretStore: PrepareStorage = async (input, secrets) => {
  try {
    const prepared = await credentials(input, secrets);
    const { company, environment } = input;
    const hash = digest(prepared.password),
      role = escapeIdentifier(prepared.role);
    await connected(prepared.admin, async (db) => {
      await db.query("BEGIN");
      try {
        await db.query("SELECT pg_advisory_xact_lock(hashtext('sanoma.prepareSecretStore'))");
        await db.query(KMS_SECRETS_SQL);
        await db.query(BINDING_SQL);
        const existing = (
          await db.query<{ company: string; environment: string; runtime_role: string; credential_hash: string }>(
            "SELECT company,environment,runtime_role,credential_hash FROM sanoma_kms.deployment WHERE singleton=true FOR UPDATE",
          )
        ).rows[0];
        if (existing) {
          if (
            existing.company !== company ||
            existing.environment !== environment ||
            existing.runtime_role !== prepared.role ||
            existing.credential_hash !== hash
          )
            fail("conflict");
        } else {
          if (
            (await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [prepared.role])).rowCount ||
            (await db.query("SELECT 1 FROM sanoma_kms.secrets LIMIT 1")).rowCount
          )
            fail("conflict");
          await db.query(
            `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(verifier(prepared.password))}`,
          );
          await db.query(
            "INSERT INTO sanoma_kms.deployment(company,environment,runtime_role,credential_hash) VALUES($1,$2,$3,$4)",
            [company, environment, prepared.role, hash],
          );
        }
        // Never silently repair/adopt an unexpectedly privileged role on a retry.
        const authority = (
          await db.query<{ safe: boolean }>(
            `SELECT (
          NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
          AND r.rolcanlogin AND NOT r.rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='sanoma_kms' AND nspowner=r.oid)
        ) AS safe FROM pg_roles r WHERE rolname=$1`,
            [prepared.role],
          )
        ).rows[0];
        if (!authority?.safe) fail("denied");
        const database = (await db.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
        await db.query(`REVOKE ALL ON DATABASE ${escapeIdentifier(database)} FROM PUBLIC`);
        await db.query(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${escapeIdentifier(database)} TO ${role}`);
        await db.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        await db.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
        await db.query(`GRANT USAGE ON SCHEMA sanoma_kms TO ${role}`);
        await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON sanoma_kms.secrets TO ${role}`);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    // A committed schema is not enough: the stored login must work with the promised authority.
    await connected(prepared.runtime, async (db) => {
      const { rows } = await db.query<{ safe: boolean }>(
        `SELECT (
        current_user=$1 AND has_schema_privilege(current_user,'sanoma_kms','USAGE')
        AND NOT has_schema_privilege(current_user,'sanoma_kms','CREATE')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','SELECT')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','INSERT')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','UPDATE')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','DELETE')
        AND NOT has_table_privilege(current_user,'sanoma_kms.secrets','TRUNCATE,TRIGGER,REFERENCES')
        AND NOT has_table_privilege(current_user,'sanoma_kms.deployment','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      ) AS safe`,
        [prepared.role],
      );
      if (!rows[0]?.safe) fail("denied");
    });
    return prepared.receipt;
  } catch (error) {
    const known = storageProvisioningCode(error);
    if (known) throw new StorageProvisioningError(known);
    const code = (error as { code?: string } | null)?.code;
    throw new StorageProvisioningError(
      code === "42501" ? "denied" : code === "23505" || code === "42710" ? "conflict" : "unavailable",
    );
  }
};

/** Sandbox keeps generated credentials in memory and performs no database calls. */
export function memoryStorageProvisioning(): PrepareStorage {
  const bindings = new Map<string, string>();
  return async (input, secrets) => {
    const prepared = await credentials(input, secrets);
    const url = new URL(prepared.admin);
    url.username = "";
    url.password = "";
    const binding = JSON.stringify([input.company, input.environment, digest(prepared.password)]);
    if (bindings.has(url.href) && bindings.get(url.href) !== binding) fail("conflict");
    bindings.set(url.href, binding);
    return prepared.receipt;
  };
}
