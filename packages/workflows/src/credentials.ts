import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { credentials } from "./db/company.ts";
import {
  SecretAccess,
  SecretStoreError,
  checkSecretConfiguration,
  isSecretStoreFactory,
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

const returned = {
  value: credentials.value,
  version: credentials.version,
  setBy: credentials.setBy,
  setAt: credentials.setAt,
};
type Row = { value: string; version: string; setBy: string; setAt: Date };
const at = ({ namespace, path }: SecretAddress) =>
  and(eq(credentials.namespace, namespace), eq(credentials.name, path));
const identity = ({ namespace, path }: SecretAddress) => JSON.stringify([namespace, path]);
const decoded = (address: SecretAddress, row: Row): SecretValue => ({
  value: decrypt(identity(address), row.value),
  version: row.version,
  updatedBy: row.setBy,
  updatedAt: row.setAt.toISOString(),
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
      await (await db()).select({ namespace: credentials.namespace }).from(credentials).limit(0);
    },
    async read(address) {
      const [row] = await (await db()).select(returned).from(credentials).where(at(address));
      return row && decoded(address, row);
    },
    async write(address, value, { expectedVersion, by }) {
      if (Buffer.byteLength(value) > 65_536) throw new SecretStoreError("too_large");
      const version = randomUUID();
      const sealed = encrypt(identity(address), value);
      const database = await db();
      const [row] =
        expectedVersion === null
          ? await database
              .insert(credentials)
              .values({ namespace: address.namespace, name: address.path, value: sealed, version, setBy: by })
              .onConflictDoNothing()
              .returning(returned)
          : await database
              .update(credentials)
              .set({ value: sealed, version, setBy: by, setAt: sql`now()` })
              .where(and(at(address), eq(credentials.version, expectedVersion)))
              .returning(returned);
      if (!row) throw new SecretStoreError("conflict");
      return decoded(address, row);
    },
    async delete(address, { expectedVersion }) {
      const deleted = await (
        await db()
      )
        .delete(credentials)
        .where(and(at(address), eq(credentials.version, expectedVersion)))
        .returning({ name: credentials.name });
      if (!deleted.length) throw new SecretStoreError("conflict");
    },
  };
}

export function configuredSecrets(config: SecretConfiguration, db: () => Promise<Db>): SecretAccess {
  checkSecretConfiguration(config);
  const selected = config.store;
  if (!selected || !isSecretStoreFactory(selected)) return new SecretAccess(config, postgresSecretStore(db));
  try {
    const store = selected.create({ database: db });
    checkSecretConfiguration({ store });
    if (
      isSecretStoreFactory(store) ||
      (store.close !== undefined && typeof store.close !== "function") ||
      store.id !== selected.id ||
      (Object.keys(selected.capabilities) as (keyof typeof selected.capabilities)[]).some(
        (key) => store.capabilities[key] !== selected.capabilities[key],
      )
    )
      throw new SecretStoreError("invalid_configuration");
    return new SecretAccess(
      { ...config, store },
      postgresSecretStore(db),
      undefined,
      () => store.close?.() ?? Promise.resolve(),
    );
  } catch {
    // Config construction may otherwise leak a provider's bootstrap/database diagnostics.
    throw new SecretStoreError("invalid_configuration");
  }
}
