import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Client } from "pg";
import { databaseOn, type Db } from "./db.ts";
import { kmsDeployment, kmsSecrets } from "./db/kms.ts";
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
/** Installs the deployment binding table beside `KMS_SECRETS_SQL`; an administrator creates it, the runtime never does. */
export const BINDING_SQL = `CREATE TABLE IF NOT EXISTS sanoma_kms.deployment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  company text NOT NULL, environment text NOT NULL, runtime_role text NOT NULL,
  credential_hash text NOT NULL
);
REVOKE ALL ON sanoma_kms.deployment FROM PUBLIC;`;

// Neon requires the original password, not a client-computed SCRAM verifier. Bind it
// as a parameter to a session-private invoker function: it stays out of submitted
// SQL statement text and Postgres performs the password hashing. The trusted database
// receives the value over verified TLS; this is not protection against its administrator.
const CREATE_RUNTIME_SQL = `CREATE FUNCTION pg_temp.sanoma_create_runtime(role_name text, role_password text)
RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
    role_name, role_password);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Runtime role creation failed' USING ERRCODE = SQLSTATE;
END
$body$;`;

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

async function connected<T>(url: string, run: (db: Db) => Promise<T>): Promise<T> {
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
    return await run(databaseOn(db));
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
      role = sql.identifier(prepared.role);
    await connected(prepared.admin, (db) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sanoma.prepareSecretStore'))`);
        await tx.execute(sql.raw(KMS_SECRETS_SQL));
        await tx.execute(sql.raw(BINDING_SQL));
        const [existing] = await tx.select().from(kmsDeployment).where(eq(kmsDeployment.singleton, true)).for("update");
        if (existing) {
          if (
            existing.company !== company ||
            existing.environment !== environment ||
            existing.runtimeRole !== prepared.role ||
            existing.credentialHash !== hash
          )
            fail("conflict");
        } else {
          if (
            (await tx.execute(sql`SELECT 1 FROM pg_roles WHERE rolname = ${prepared.role}`)).rowCount ||
            (
              await tx
                .select({ one: sql`1` })
                .from(kmsSecrets)
                .limit(1)
            ).length
          )
            fail("conflict");
          await tx.execute(sql`SET LOCAL password_encryption = 'scram-sha-256'`);
          await tx.execute(sql.raw(CREATE_RUNTIME_SQL));
          await tx.execute(sql`SELECT pg_temp.sanoma_create_runtime(${prepared.role}, ${prepared.password})`);
          await tx
            .insert(kmsDeployment)
            .values({ company, environment, runtimeRole: prepared.role, credentialHash: hash });
        }
        // Never silently repair/adopt an unexpectedly privileged role on a retry.
        const authority = (
          await tx.execute<{ safe: boolean }>(sql`SELECT (
          NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
          AND r.rolcanlogin AND NOT r.rolinherit
          AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
          AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='sanoma_kms' AND nspowner=r.oid)
        ) AS safe FROM pg_roles r WHERE rolname = ${prepared.role}`)
        ).rows[0];
        if (!authority?.safe) fail("denied");
        const database = sql.identifier(
          (await tx.execute<{ name: string }>(sql`SELECT current_database() AS name`)).rows[0]!.name,
        );
        await tx.execute(sql`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
        await tx.execute(sql`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${database} TO ${role}`);
        await tx.execute(sql`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
        await tx.execute(sql`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
        await tx.execute(sql`GRANT USAGE ON SCHEMA sanoma_kms TO ${role}`);
        await tx.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON sanoma_kms.secrets TO ${role}`);
      }),
    );
    // A committed schema is not enough: the stored login must work with the promised authority.
    await connected(prepared.runtime, async (db) => {
      const { rows } = await db.execute<{ safe: boolean }>(sql`SELECT (
        current_user = ${prepared.role} AND has_schema_privilege(current_user,'sanoma_kms','USAGE')
        AND NOT has_schema_privilege(current_user,'sanoma_kms','CREATE')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','SELECT')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','INSERT')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','UPDATE')
        AND has_table_privilege(current_user,'sanoma_kms.secrets','DELETE')
        AND NOT has_table_privilege(current_user,'sanoma_kms.secrets','TRUNCATE,TRIGGER,REFERENCES')
        AND NOT has_table_privilege(current_user,'sanoma_kms.deployment','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      ) AS safe`);
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
