import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import type { Db } from "./db.ts";
import { SecretStoreError, type SecretAddress, type SecretStore, type SecretValue } from "./secret-store.ts";

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

export interface KmsPostgresOptions {
  /** Fixed by trusted deployment bootstrap. IAM must independently enforce this company context. */
  company: string;
  /** Immutable key ARN for new writes; aliases are deliberately unsupported. */
  keyArn: string;
  /** Retained key ARNs allowed for reads during key replacement/backup recovery. */
  decryptKeyArns?: readonly string[];
  /** Explicit client under a company-scoped IAM identity, never fleet credentials. Caller owns its lifecycle. */
  kms: Pick<KMSClient, "send">;
  /** Company-scoped database access. Caller owns connection lifecycle; never shared admin authority. */
  database: () => Promise<Db>;
}

interface Envelope {
  format: "sanoma-kms-v1";
  key: string;
  wrapped: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
interface Row {
  version: string;
  envelope: Envelope;
  updated_by: string;
  updated_at: Date;
}
const FORMAT = "sanoma-kms-v1";
const MAX_BYTES = 65_536;
const keyArn = /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9-]+$/;
const nonempty = (v: string) => typeof v === "string" && v.length > 0 && v.length <= 1024 && !v.includes("\0");
const failed = (error: unknown): never => {
  if (error instanceof SecretStoreError) throw error;
  const name = (error as { name?: string } | null)?.name;
  const code = (error as { code?: string } | null)?.code;
  throw new SecretStoreError(
    name === "AccessDeniedException" || code === "42501"
      ? "denied"
      : name === "InvalidCiphertextException" || name === "IncorrectKeyException"
        ? "invalid_value"
        : name === "NotFoundException" || name === "DisabledException" || code === "42P01"
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

/** Versioned envelope encryption; no plaintext/data-key cache, no SANOMA_SECRETS_KEY and no Secrets Manager. */
export function kmsPostgresStore(options: KmsPostgresOptions): SecretStore {
  const { company, keyArn: writeKey, kms, database } = options;
  const keys = new Set([writeKey, ...(options.decryptKeyArns ?? [])]);
  if (!nonempty(company) || [...keys].some((k) => !keyArn.test(k))) throw new SecretStoreError("invalid_configuration");
  const context = (address: SecretAddress, version: string) => {
    if (!nonempty(address.namespace) || !nonempty(address.path)) throw new SecretStoreError("invalid_configuration");
    return { company, namespace: address.namespace, path: address.path, version, format: FORMAT };
  };
  const seal = async (address: SecretAddress, value: string, version: string): Promise<Envelope> => {
    const bound = context(address, version);
    const generated = await kms.send(
      new GenerateDataKeyCommand({ KeyId: writeKey, KeySpec: "AES_256", EncryptionContext: bound }),
    );
    try {
      if (generated.KeyId !== writeKey || generated.Plaintext?.length !== 32 || !generated.CiphertextBlob?.length)
        throw new SecretStoreError("invalid_value");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", generated.Plaintext, nonce).setAAD(
        Buffer.from(JSON.stringify(bound)),
      );
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return {
        format: FORMAT,
        key: writeKey,
        wrapped: Buffer.from(generated.CiphertextBlob).toString("base64"),
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      };
    } finally {
      generated.Plaintext?.fill(0);
    }
  };
  const open = async (address: SecretAddress, row: Row): Promise<SecretValue> => {
    const e = row.envelope;
    if (!e || e.format !== FORMAT || !keys.has(e.key)) throw new SecretStoreError("invalid_value");
    const nonce = bytes(e.nonce, 12),
      tag = bytes(e.tag, 16),
      ciphertext = bytes(e.ciphertext),
      wrapped = bytes(e.wrapped, undefined, 6144);
    if (ciphertext.length > MAX_BYTES || !wrapped.length || wrapped.length > 6144)
      throw new SecretStoreError("invalid_value");
    const bound = context(address, row.version);
    const decrypted = await kms.send(
      new DecryptCommand({
        KeyId: e.key,
        CiphertextBlob: wrapped,
        EncryptionContext: bound,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      }),
    );
    try {
      if (decrypted.KeyId !== e.key || decrypted.Plaintext?.length !== 32) throw new SecretStoreError("invalid_value");
      const decipher = createDecipheriv("aes-256-gcm", decrypted.Plaintext, nonce)
        .setAAD(Buffer.from(JSON.stringify(bound)))
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
          updatedBy: row.updated_by,
          updatedAt: row.updated_at.toISOString(),
        };
      } finally {
        plaintext.fill(0);
      }
    } finally {
      decrypted.Plaintext?.fill(0);
    }
  };
  return {
    id: "kms-postgres",
    capabilities: Object.freeze({
      writable: true,
      maxBytes: MAX_BYTES,
      conditionalWrites: "atomic",
      deletion: "destroy",
      changeDetection: "read",
    }),
    validate: (namespace) =>
      safe(async () => {
        const address = { namespace, path: "__validation__" },
          version = randomUUID();
        const envelope = await seal(address, "validation", version);
        await open(address, { envelope, version, updated_by: "validation", updated_at: new Date() });
        await (await database()).query("SELECT version FROM sanoma_kms.secrets WHERE company=$1 LIMIT 0", [company]);
        // Fail a positive scope check closed: a deployment identity must not mint data keys for another company.
        try {
          const probe = await kms.send(
            new GenerateDataKeyCommand({
              KeyId: writeKey,
              KeySpec: "AES_256",
              EncryptionContext: { ...context(address, version), company: `scope-probe-${randomUUID()}` },
            }),
          );
          probe.Plaintext?.fill(0);
        } catch (error) {
          if ((error as { name?: string } | null)?.name === "AccessDeniedException") return;
          throw error;
        }
        throw new SecretStoreError("invalid_configuration");
      }),
    read: (address) =>
      safe(async () => {
        context(address, "read");
        const { rows } = await (
          await database()
        ).query<Row>(
          "SELECT version,envelope,updated_by,updated_at FROM sanoma_kms.secrets WHERE company=$1 AND namespace=$2 AND path=$3",
          [company, address.namespace, address.path],
        );
        return rows[0] && open(address, rows[0]);
      }),
    write: (address, value, { expectedVersion, by }) =>
      safe(async () => {
        if (Buffer.byteLength(value, "utf8") > MAX_BYTES) throw new SecretStoreError("too_large");
        if (!nonempty(by)) throw new SecretStoreError("invalid_value");
        const version = randomUUID(),
          envelope = await seal(address, value, version);
        const args = [company, address.namespace, address.path, version, JSON.stringify(envelope), by];
        const sql =
          expectedVersion === null
            ? "INSERT INTO sanoma_kms.secrets(company,namespace,path,version,envelope,updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company,namespace,path) DO NOTHING RETURNING version,envelope,updated_by,updated_at"
            : "UPDATE sanoma_kms.secrets SET version=$4,envelope=$5,updated_by=$6,updated_at=now() WHERE company=$1 AND namespace=$2 AND path=$3 AND version::text=$7 RETURNING version,envelope,updated_by,updated_at";
        const { rows } = await (
          await database()
        ).query<Row>(sql, expectedVersion === null ? args : [...args, expectedVersion]);
        if (!rows[0]) throw new SecretStoreError("conflict");
        // Return the caller's value, never make a second decrypt after a successful commit.
        return { value, version, updatedBy: by, updatedAt: rows[0].updated_at.toISOString() };
      }),
    delete: (address, { expectedVersion }) =>
      safe(async () => {
        context(address, expectedVersion);
        const { rowCount } = await (
          await database()
        ).query("DELETE FROM sanoma_kms.secrets WHERE company=$1 AND namespace=$2 AND path=$3 AND version::text=$4", [
          company,
          address.namespace,
          address.path,
          expectedVersion,
        ]);
        if (!rowCount) throw new SecretStoreError("conflict");
      }),
  };
}
