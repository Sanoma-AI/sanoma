import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { CREDENTIALS_TABLE as TABLE, type Db } from "./db.ts";
import {
  SecretAccess,
  SecretStoreError,
  type SecretAddress,
  type SecretConfiguration,
  type SecretStore,
  type SecretValue,
} from "./secret-store.ts";
import { deploymentKey } from "./deployment-key.ts";

export const SECRETS_KEY = "SANOMA_SECRETS_KEY";
const V1 = "v1:";

/** AES-256-GCM authenticated to the complete namespace/path identity. No plaintext format. */
export function encrypt(identity: string, value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deploymentKey(SECRETS_KEY), nonce).setAAD(Buffer.from(identity));
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${V1}${nonce.toString("base64")}:${sealed.toString("base64")}`;
}

export function decrypt(identity: string, stored: string): string {
  if (!stored.startsWith(V1)) throw new SecretStoreError("invalid_value");
  const key = deploymentKey(SECRETS_KEY);
  try {
    const parts = stored.slice(V1.length).split(":");
    if (parts.length !== 2) throw new Error("format");
    const nonce = Buffer.from(parts[0]!, "base64");
    const sealed = Buffer.from(parts[1]!, "base64");
    if (nonce.length !== 12 || sealed.length < 16) throw new Error("format");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce).setAAD(Buffer.from(identity));
    decipher.setAuthTag(sealed.subarray(-16));
    return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretStoreError("invalid_value");
  }
}

type Row = { value: string; version: string; set_by: string; set_at: Date };
const identity = ({ namespace, path }: SecretAddress) => JSON.stringify([namespace, path]);
const decoded = (address: SecretAddress, row: Row): SecretValue => ({
  value: decrypt(identity(address), row.value),
  version: row.version,
  updatedBy: row.set_by,
  updatedAt: row.set_at.toISOString(),
});

/** One company's database connection supplies authority; namespace separates deployments within it. */
export function postgresSecretStore(db: () => Promise<Db>): SecretStore {
  return {
    id: "postgres",
    capabilities: Object.freeze({
      writable: true,
      maxBytes: 65_536,
      conditionalWrites: "atomic",
      deletion: "destroy",
      changeDetection: "read",
    }),
    async validate(namespace) {
      if (!namespace) throw new SecretStoreError("invalid_configuration");
      deploymentKey(SECRETS_KEY);
      await (await db()).query(`SELECT namespace FROM ${TABLE} LIMIT 0`);
    },
    async read(address) {
      const { rows } = await (
        await db()
      ).query<Row>(`SELECT value, version, set_by, set_at FROM ${TABLE} WHERE namespace = $1 AND name = $2`, [
        address.namespace,
        address.path,
      ]);
      return rows[0] && decoded(address, rows[0]);
    },
    async write(address, value, { expectedVersion, by }) {
      if (Buffer.byteLength(value) > 65_536) throw new SecretStoreError("too_large");
      const version = randomUUID();
      const sealed = encrypt(identity(address), value);
      const query =
        expectedVersion === null
          ? `INSERT INTO ${TABLE} (namespace,name,value,version,set_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (namespace,name) DO NOTHING RETURNING value,version,set_by,set_at`
          : `UPDATE ${TABLE} SET value=$3,version=$4,set_by=$5,set_at=now() WHERE namespace=$1 AND name=$2 AND version=$6 RETURNING value,version,set_by,set_at`;
      const params = [
        address.namespace,
        address.path,
        sealed,
        version,
        by,
        ...(expectedVersion === null ? [] : [expectedVersion]),
      ];
      const { rows } = await (await db()).query<Row>(query, params);
      if (!rows[0]) throw new SecretStoreError("conflict");
      return decoded(address, rows[0]);
    },
    async delete(address, { expectedVersion }) {
      const { rowCount } = await (
        await db()
      ).query(`DELETE FROM ${TABLE} WHERE namespace=$1 AND name=$2 AND version=$3`, [
        address.namespace,
        address.path,
        expectedVersion,
      ]);
      if (!rowCount) throw new SecretStoreError("conflict");
    },
  };
}

export const configuredSecrets = (config: SecretConfiguration, db: () => Promise<Db>): SecretAccess =>
  new SecretAccess(config, postgresSecretStore(db));
