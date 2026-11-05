import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { protos } from "@google-cloud/kms";
import crc32c from "crc-32/crc32c.js";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { kmsSecrets } from "./db/kms.ts";
import { cloudIdentityAuth } from "./cloud-identity.ts";
import {
  SecretStoreError,
  type SecretAddress,
  type SecretStore,
  type SecretStoreFactory,
  type SecretValue,
} from "./secret-store.ts";

/** Install with a privileged connection; runtime needs only SELECT/INSERT/UPDATE/DELETE on its company database. */
export const KMS_SECRETS_SQL = `
CREATE SCHEMA IF NOT EXISTS sanoma_kms;
REVOKE ALL ON SCHEMA sanoma_kms FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sanoma_kms.secrets (
  company text NOT NULL, namespace text NOT NULL, path text NOT NULL,
  version uuid NOT NULL, envelope jsonb NOT NULL,
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, namespace, path)
);
REVOKE ALL ON sanoma_kms.secrets FROM PUBLIC;
DO $revoke$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sanoma_kms FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON sanoma_kms.secrets FROM %I', api_role);
    END IF;
  END LOOP;
END;
$revoke$;
`;

/** Promise interface implemented by Google's KeyManagementServiceClient. */
export interface GcpKmsClient {
  encrypt(
    request: protos.google.cloud.kms.v1.IEncryptRequest,
  ): Promise<[protos.google.cloud.kms.v1.IEncryptResponse, ...unknown[]]>;
  decrypt(
    request: protos.google.cloud.kms.v1.IDecryptRequest,
  ): Promise<[protos.google.cloud.kms.v1.IDecryptResponse, ...unknown[]]>;
}

export interface KmsPostgresOptions {
  /** Fixed by trusted deployment bootstrap. IAM must independently restrict the runtime to this company’s CryptoKeys. */
  company: string;
  /** Full GCP CryptoKey resource name for new writes, using its primary version. */
  keyName: string;
  /** Retained CryptoKey names allowed for reads during key replacement/backup recovery. */
  decryptKeyNames?: readonly string[];
  /** Explicit client under a company-scoped IAM identity, never fleet credentials. Caller owns its lifecycle. */
  kms: GcpKmsClient;
  /** Omit in config to use the runtime's database. An explicit connection remains caller-owned. */
  database?: () => Promise<Db>;
}

export interface Envelope {
  format: "sanoma-gcp-kms-v1";
  key: string;
  keyVersion: string;
  wrapped: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
const columns = {
  version: kmsSecrets.version,
  envelope: kmsSecrets.envelope,
  updatedBy: kmsSecrets.updatedBy,
  updatedAt: kmsSecrets.updatedAt,
};
type Row = Pick<typeof kmsSecrets.$inferSelect, keyof typeof columns>;
const at = (company: string, address: SecretAddress) =>
  and(eq(kmsSecrets.company, company), eq(kmsSecrets.namespace, address.namespace), eq(kmsSecrets.path, address.path));
/** The row of `version`, compared as text: an expected version that is no uuid matches nothing. */
const versionIs = (version: string) => sql`${kmsSecrets.version}::text = ${version}`;
const FORMAT = "sanoma-gcp-kms-v1";
const MAX_BYTES = 65_536;
const capabilities = Object.freeze({
  writable: true,
  maxBytes: MAX_BYTES,
  conditionalWrites: "atomic" as const,
  deletion: "destroy" as const,
  changeDetection: "read" as const,
});
const keyName =
  /^projects\/[a-zA-Z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;
const nonempty = (v: string) =>
  typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf8") <= 1024 && !v.includes("\0");
const failed = (error: unknown): never => {
  if (error instanceof SecretStoreError) throw error;
  const code = (error as { code?: string | number } | null)?.code;
  throw new SecretStoreError(
    code === 7 || code === 16 || code === "42501"
      ? "denied"
      : code === 3
        ? "invalid_value"
        : code === 5 || code === 9 || code === "42P01"
          ? "invalid_configuration"
          : "unavailable",
  );
};
const safe = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (e) {
    return failed(e);
  }
};
const bytes = (v: string, length?: number, max = MAX_BYTES): Buffer => {
  if (
    typeof v !== "string" ||
    v.length > Math.ceil((length ?? max) / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
  )
    throw new SecretStoreError("invalid_value");
  const b = Buffer.from(v, "base64");
  if (length !== undefined && b.length !== length) throw new SecretStoreError("invalid_value");
  return b;
};

const versionOf = (name: unknown, key: string): name is string =>
  typeof name === "string" &&
  name.startsWith(`${key}/cryptoKeyVersions/`) &&
  /^[1-9][0-9]{0,19}$/.test(name.slice(`${key}/cryptoKeyVersions/`.length));
const checksum = (value: Uint8Array) => crc32c.buf(value) >>> 0;

function checkedKeys(options: Pick<KmsPostgresOptions, "company" | "keyName" | "decryptKeyNames">): Set<string> {
  const keys = new Set([options.keyName, ...(options.decryptKeyNames ?? [])]);
  if (!nonempty(options.company) || [...keys].some((key) => !nonempty(key) || !keyName.test(key)))
    throw new SecretStoreError("invalid_configuration");
  return keys;
}

export type ManagedKmsOptions = Pick<KmsPostgresOptions, "company" | "keyName" | "decryptKeyNames"> & {
  /** Fixed deployment broker; the callback reads protected bootstrap again on renewal. */
  identity: { endpoint: string; credential(): Promise<string> };
};

/** Config composition for managed Cloud. Each runtime owns its lazily opened SDK client and database binding. */
export function managedKmsStore(options: ManagedKmsOptions): SecretStoreFactory {
  const keys = checkedKeys(options);
  const { company, keyName: writeKey } = options;
  const identity = { ...options.identity };
  if (typeof identity.credential !== "function") throw new SecretStoreError("invalid_configuration");
  return Object.freeze({
    kind: "runtime",
    id: "kms-postgres",
    capabilities,
    create({ database }: { database: () => Promise<Db> }) {
      const authClient = cloudIdentityAuth(identity);
      let closed = false;
      let pending: Promise<GcpKmsClient & { close(): Promise<void> }> | undefined;
      const client = () => {
        if (closed) throw new SecretStoreError("unavailable");
        return (pending ??= import("@google-cloud/kms").then(
          ({ KeyManagementServiceClient }) => new KeyManagementServiceClient({ authClient }),
        ));
      };
      const kms: GcpKmsClient = {
        encrypt: async (request) => (await client()).encrypt(request),
        decrypt: async (request) => (await client()).decrypt(request),
      };
      return {
        ...kmsPostgresStore({ company, keyName: writeKey, decryptKeyNames: [...keys], database, kms }),
        async close() {
          if (closed) return;
          closed = true;
          if (pending) await (await pending).close();
        },
      };
    },
  });
}

/** Versioned envelope encryption; no plaintext/data-key cache, no SANOMA_SECRETS_KEY and no Secrets Manager. */
export function kmsPostgresStore(options: KmsPostgresOptions & { database: () => Promise<Db> }): SecretStore;
export function kmsPostgresStore(options: KmsPostgresOptions & { database?: undefined }): SecretStoreFactory;
export function kmsPostgresStore(options: KmsPostgresOptions): SecretStore | SecretStoreFactory;
export function kmsPostgresStore(options: KmsPostgresOptions): SecretStore | SecretStoreFactory {
  const { company, keyName: writeKey, kms, database } = options;
  const keys = checkedKeys(options);
  if (
    typeof kms?.encrypt !== "function" ||
    typeof kms?.decrypt !== "function" ||
    (database !== undefined && typeof database !== "function")
  )
    throw new SecretStoreError("invalid_configuration");
  if (!database)
    return Object.freeze({
      kind: "runtime",
      id: "kms-postgres",
      capabilities,
      create: ({ database: runtimeDatabase }: { database: () => Promise<Db> }) =>
        kmsPostgresStore({
          company,
          keyName: writeKey,
          decryptKeyNames: [...keys],
          kms,
          database: runtimeDatabase,
        }),
    });
  const context = (address: SecretAddress, version: string) => {
    if (!nonempty(address.namespace) || !nonempty(address.path)) throw new SecretStoreError("invalid_configuration");
    return { company, namespace: address.namespace, path: address.path, version, format: FORMAT };
  };
  const seal = async (address: SecretAddress, value: string, version: string): Promise<Envelope> => {
    const bound = context(address, version);
    const aad = Buffer.from(JSON.stringify(bound));
    const dataKey = randomBytes(32);
    try {
      const [encrypted] = await kms.encrypt({
        name: writeKey,
        plaintext: dataKey,
        plaintextCrc32c: { value: checksum(dataKey) },
        additionalAuthenticatedData: aad,
        additionalAuthenticatedDataCrc32c: { value: checksum(aad) },
      });
      const wrapped =
        typeof encrypted.ciphertext === "string" ? bytes(encrypted.ciphertext, undefined, 6144) : encrypted.ciphertext;
      if (
        !versionOf(encrypted.name, writeKey) ||
        !wrapped?.length ||
        wrapped.length > 6144 ||
        !encrypted.verifiedPlaintextCrc32c ||
        !encrypted.verifiedAdditionalAuthenticatedDataCrc32c ||
        Number(encrypted.ciphertextCrc32c?.value ?? NaN) !== checksum(wrapped)
      )
        throw new SecretStoreError("invalid_value");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, nonce).setAAD(
        Buffer.from(JSON.stringify({ ...bound, keyVersion: encrypted.name })),
      );
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return {
        format: FORMAT,
        key: writeKey,
        keyVersion: encrypted.name,
        wrapped: Buffer.from(wrapped).toString("base64"),
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    } finally {
      dataKey.fill(0);
    }
  };
  const open = async (address: SecretAddress, row: Row): Promise<SecretValue> => {
    // A JSON `null` is a jsonb value the column takes: an envelope written by hand, not one of ours.
    const e = row.envelope as Envelope | null;
    if (!e || e.format !== FORMAT || !keys.has(e.key) || !versionOf(e.keyVersion, e.key))
      throw new SecretStoreError("invalid_value");
    const nonce = bytes(e.nonce, 12),
      tag = bytes(e.tag, 16),
      ciphertext = bytes(e.ciphertext),
      wrapped = bytes(e.wrapped, undefined, 6144);
    if (ciphertext.length > MAX_BYTES || !wrapped.length || wrapped.length > 6144)
      throw new SecretStoreError("invalid_value");
    const bound = context(address, row.version);
    const aad = Buffer.from(JSON.stringify(bound));
    const [decrypted] = await kms.decrypt({
      name: e.key,
      ciphertext: wrapped,
      ciphertextCrc32c: { value: checksum(wrapped) },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: checksum(aad) },
    });
    const dataKey = typeof decrypted.plaintext === "string" ? bytes(decrypted.plaintext, 32) : decrypted.plaintext;
    try {
      if (dataKey?.length !== 32 || Number(decrypted.plaintextCrc32c?.value ?? NaN) !== checksum(dataKey))
        throw new SecretStoreError("invalid_value");
      const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce)
        .setAAD(Buffer.from(JSON.stringify({ ...bound, keyVersion: e.keyVersion })))
        .setAuthTag(tag);
      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new SecretStoreError("invalid_value");
      }
      try {
        return {
          value: plaintext.toString("utf8"),
          version: row.version,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt.toISOString(),
        };
      } finally {
        plaintext.fill(0);
      }
    } finally {
      dataKey?.fill(0);
    }
  };
  return {
    id: "kms-postgres",
    capabilities,
    validate: (namespace) =>
      safe(async () => {
        const address = { namespace, path: `__validation__/${randomUUID()}` },
          version = randomUUID(),
          value = randomUUID();
        const envelope = await seal(address, value, version);
        const db = await database();
        const exact = and(at(company, address), eq(kmsSecrets.version, version));
        let removed = false;
        try {
          const created = await db
            .insert(kmsSecrets)
            .values({
              company,
              namespace: address.namespace,
              path: address.path,
              version,
              envelope,
              updatedBy: "validation",
            })
            .onConflictDoNothing()
            .returning({ version: kmsSecrets.version });
          if (created.length !== 1) throw new SecretStoreError("conflict");
          const updated = await db
            .update(kmsSecrets)
            .set({ envelope, version, updatedBy: "validation" })
            .where(exact)
            .returning({ version: kmsSecrets.version });
          if (updated.length !== 1) throw new SecretStoreError("unavailable");
          const [stored] = await db.select(columns).from(kmsSecrets).where(exact);
          if (!stored || (await open(address, stored)).value !== value) throw new SecretStoreError("invalid_value");
        } finally {
          // Also clean up a committed INSERT whose response was lost. The random address and
          // exact version prevent one concurrent probe from deleting another probe or a secret.
          const cleanup = await db.delete(kmsSecrets).where(exact).returning({ version: kmsSecrets.version });
          removed = cleanup.length === 1;
        }
        if (!removed) throw new SecretStoreError("unavailable");
        // Own-key usability only. Cross-company authorization requires live IAM proof with another existing key.
      }),
    read: (address) =>
      safe(async () => {
        context(address, "read");
        const [row] = await (await database()).select(columns).from(kmsSecrets).where(at(company, address));
        return row && open(address, row);
      }),
    write: (address, value, { expectedVersion, by }) =>
      safe(async () => {
        if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new SecretStoreError("too_large");
        if (!nonempty(by)) throw new SecretStoreError("invalid_value");
        const version = randomUUID(),
          envelope = await seal(address, value, version);
        const db = await database();
        const [row] =
          expectedVersion === null
            ? await db
                .insert(kmsSecrets)
                .values({ company, namespace: address.namespace, path: address.path, version, envelope, updatedBy: by })
                .onConflictDoNothing()
                .returning({ updatedAt: kmsSecrets.updatedAt })
            : await db
                .update(kmsSecrets)
                .set({ version, envelope, updatedBy: by })
                .where(and(at(company, address), versionIs(expectedVersion)))
                .returning({ updatedAt: kmsSecrets.updatedAt });
        if (!row) throw new SecretStoreError("conflict");
        // Return the caller's value, never make a second decrypt after a successful commit.
        return { value, version, updatedBy: by, updatedAt: row.updatedAt.toISOString() };
      }),
    delete: (address, { expectedVersion }) =>
      safe(async () => {
        context(address, expectedVersion);
        const deleted = await (
          await database()
        )
          .delete(kmsSecrets)
          .where(and(at(company, address), versionIs(expectedVersion)))
          .returning({ version: kmsSecrets.version });
        if (!deleted.length) throw new SecretStoreError("conflict");
      }),
  };
}
