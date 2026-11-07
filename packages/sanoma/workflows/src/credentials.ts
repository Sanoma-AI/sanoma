import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { credentials, secretMoves } from "./db/company.ts";
import {
  SecretAccess,
  SecretStoreError,
  checkSecretConfiguration,
  isSecretStoreFactory,
  type SecretAddress,
  type SecretConfiguration,
  type SecretStore,
  type SecretStoreEntry,
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
type Row = Pick<typeof credentials.$inferSelect, keyof typeof returned>;
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
              .set({ value: sealed, version, setBy: by })
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

/**
 * A store entry opened on the runtime's database: the built-in store when it names none, a
 * factory's adapter bound to `db` (closed by `close`), or the caller's own instance (never closed
 * here). Construction errors are sanitized: they may carry a provider's bootstrap diagnostics.
 */
export function openStore(
  entry: SecretStoreEntry,
  db: () => Promise<Db>,
): { store: SecretStore; close(): Promise<void> } {
  const selected = entry.store;
  if (!selected) return { store: postgresSecretStore(db), close: async () => {} };
  if (!isSecretStoreFactory(selected)) return { store: selected, close: async () => {} };
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
    return { store, close: async () => store.close?.() };
  } catch {
    throw new SecretStoreError("invalid_configuration");
  }
}

/**
 * True while a move is taking values from `store`'s `namespace` (`sanoma_secret_moves.fenced`,
 * from its transfer until it is cancelled or another move cuts back over to it): writes and
 * deletes there are refused. An OAuth renewal asks first, before it spends a refresh token.
 */
export async function writesPaused(database: Db, store: string, namespace: string): Promise<boolean> {
  const [moving] = await database
    .select({ id: secretMoves.id })
    .from(secretMoves)
    .where(
      and(eq(secretMoves.sourceStore, store), eq(secretMoves.sourceNamespace, namespace), eq(secretMoves.fenced, true)),
    )
    .limit(1);
  return moving !== undefined;
}

/**
 * Refuses a write or delete where writes are paused (`writesPaused`): one writer, the move, while
 * values move, and none at the old store after its cutover. Reads pass.
 */
function fenced(store: SecretStore, db: () => Promise<Db>): SecretStore {
  const open = async ({ namespace }: SecretAddress) => {
    if (await writesPaused(await db(), store.id, namespace)) throw new SecretStoreError("read_only");
  };
  return {
    id: store.id,
    capabilities: store.capabilities,
    validate: (namespace) => store.validate(namespace),
    read: (address) => store.read(address),
    async write(address, value, options) {
      await open(address);
      return store.write(address, value, options);
    },
    async delete(address, options) {
      await open(address);
      return store.delete(address, options);
    },
  };
}

export function configuredSecrets(config: SecretConfiguration, db: () => Promise<Db>): SecretAccess {
  checkSecretConfiguration(config);
  const { store, close } = openStore(config, db);
  return new SecretAccess({ ...config, store: fenced(store, db) }, store, undefined, close);
}
