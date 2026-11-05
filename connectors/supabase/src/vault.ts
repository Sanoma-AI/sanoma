import { SecretStoreError, type SecretAddress, type SecretStore, type SecretValue } from "@sanoma-ai/workflows";
import { type Db, databaseOn, pgCode } from "@sanoma-ai/workflows/db";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

export interface SupabaseVaultOptions {
  /** Bootstrap environment variable containing the scoped login's Postgres URL. Never a service-role API key. */
  databaseUrlEnv?: string;
  /** Must agree with the administrator's namespace grant. External bindings stay read-only either way. */
  writable?: boolean;
}

const decoded = (result: unknown): SecretValue => {
  const v = result as Partial<SecretValue> | null;
  if (!v || typeof v.value !== "string" || typeof v.version !== "string" || !/^[a-f0-9]{64}$/.test(v.version))
    throw new SecretStoreError("unavailable");
  return {
    value: v.value,
    version: v.version,
    ...(typeof v.updatedAt === "string" && { updatedAt: v.updatedAt }),
    ...(typeof v.updatedBy === "string" && { updatedBy: v.updatedBy }),
  };
};

/** Server-only adapter over sql/vault.sql. The app never receives the database URL or decrypted view. */
export function supabaseVault(options: SupabaseVaultOptions = {}): SecretStore & { close(): Promise<void> } {
  const env = options.databaseUrlEnv ?? "SUPABASE_VAULT_DATABASE_URL";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) throw new SecretStoreError("invalid_configuration");
  const writable = options.writable ?? true;
  let db: (Db & { $client: Pool }) | undefined;
  const invoke = async (
    operation: string,
    namespace: string,
    path?: string,
    value?: string,
    expected?: string | null,
    by?: string,
  ) => {
    if (
      !namespace.trim() ||
      namespace.includes("\0") ||
      (path !== undefined && (!path || path.includes("\0") || path.length > 1024))
    )
      throw new SecretStoreError("invalid_configuration");
    try {
      if (!db) {
        const connectionString = process.env[env];
        if (!connectionString) throw new SecretStoreError("invalid_configuration");
        const pool = new Pool({
          connectionString,
          max: 4,
          idleTimeoutMillis: 1000,
          connectionTimeoutMillis: 10_000,
          statement_timeout: 15_000,
          allowExitOnIdle: true,
        });
        // Idle connection errors must not surface provider payloads through an unhandled EventEmitter error.
        pool.on("error", () => {});
        db = databaseOn(pool);
      }
      const { rows } = await db.execute<{ result: unknown }>(
        sql`SELECT sanoma_vault.access(${operation}, ${namespace}, ${path ?? null}, ${value ?? null}, ${expected ?? null}, ${by ?? null}) AS result`,
      );
      return rows[0]?.result;
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      // The driver's `code` classifies the failure; its message (the statement and its parameters) is never kept.
      const code = pgCode(error);
      throw new SecretStoreError(
        code === "42501"
          ? "denied"
          : code === "SV001"
            ? "read_only"
            : code === "SV002" || code === "23505"
              ? "conflict"
              : code === "SV003"
                ? "too_large"
                : code === "22023" || code === "42P01" || code === "42883" || code === "3F000"
                  ? "invalid_configuration"
                  : "unavailable",
      );
    }
  };
  const mutable = () => {
    if (!writable) throw new SecretStoreError("read_only");
  };
  return {
    id: "supabase-vault",
    capabilities: Object.freeze({
      writable,
      maxBytes: 65_536,
      conditionalWrites: "atomic",
      deletion: "destroy",
      changeDetection: "read",
    }),
    async validate(namespace) {
      const result = (await invoke("validate", namespace)) as { protocol?: number; writable?: boolean } | null;
      if (result?.protocol !== 1 || (writable && !result.writable)) throw new SecretStoreError("invalid_configuration");
    },
    async read({ namespace, path }: SecretAddress) {
      const result = await invoke("read", namespace, path);
      return result === null ? undefined : decoded(result);
    },
    async write({ namespace, path }, value, { expectedVersion, by }) {
      mutable();
      if (value.includes("\0")) throw new SecretStoreError("invalid_value");
      if (Buffer.byteLength(value, "utf8") > 65_536) throw new SecretStoreError("too_large");
      return decoded(await invoke("write", namespace, path, value, expectedVersion, by));
    },
    async delete({ namespace, path }, { expectedVersion, by }) {
      mutable();
      await invoke("delete", namespace, path, undefined, expectedVersion, by);
    },
    async close() {
      const current = db;
      db = undefined;
      await current?.$client.end();
    },
  };
}
