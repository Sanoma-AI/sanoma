import { randomBytes, randomUUID } from "node:crypto";
import crc32c from "crc-32/crc32c.js";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lazyPool } from "../src/db.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";
import { KMS_SECRETS_SQL, kmsPostgresStore, type GcpKmsClient } from "../src/kms-secrets.ts";

const KEY = "projects/test-project/locations/us-central1/keyRings/production/cryptoKeys/acme";
const NEXT_KEY = "projects/test-project/locations/us-central1/keyRings/production/cryptoKeys/acme-next";
const OTHER_KEY = "projects/test-project/locations/us-central1/keyRings/production/cryptoKeys/other-company";
const fail = (code: number): never => {
  throw Object.assign(new Error("synthetic sensitive provider detail"), { code });
};
const b = (value: Uint8Array | string | null | undefined) =>
  typeof value === "string" ? Buffer.from(value, "base64") : Buffer.from(value ?? []);
const wrappedKeys = new Map<string, { bytes: Buffer; aad: Buffer; key: string; version: number }>();

/** Models per-CryptoKey IAM and version retention; payload AES and Postgres remain real. AAD is not IAM. */
function fakeKms(allowed: string[]) {
  const returned: Uint8Array[] = [];
  const state = {
    denied: false,
    primary: 1,
    disabledVersions: new Set<number>(),
    badEncryptCrc: false,
    badDecryptCrc: false,
    unverified: false,
    wrongName: false,
  };
  const client: GcpKmsClient = {
    async encrypt(input) {
      if (state.denied || !allowed.includes(input.name!)) fail(7);
      const plain = b(input.plaintext),
        aad = b(input.additionalAuthenticatedData);
      expect(Number(input.plaintextCrc32c?.value)).toBe(crc32c.buf(plain) >>> 0);
      expect(Number(input.additionalAuthenticatedDataCrc32c?.value)).toBe(crc32c.buf(aad) >>> 0);
      returned.push(input.plaintext as Uint8Array);
      const wrapped = randomBytes(32);
      wrappedKeys.set(wrapped.toString("base64"), { bytes: plain, aad, key: input.name!, version: state.primary });
      return [
        {
          name: `${state.wrongName ? OTHER_KEY : input.name}/cryptoKeyVersions/${state.primary}`,
          ciphertext: wrapped,
          ciphertextCrc32c: { value: state.badEncryptCrc ? -1 : crc32c.buf(wrapped) >>> 0 },
          verifiedPlaintextCrc32c: !state.unverified,
          verifiedAdditionalAuthenticatedDataCrc32c: !state.unverified,
        },
      ];
    },
    async decrypt(input) {
      if (state.denied || !allowed.includes(input.name!)) fail(7);
      const wrapped = b(input.ciphertext),
        aad = b(input.additionalAuthenticatedData);
      expect(Number(input.ciphertextCrc32c?.value)).toBe(crc32c.buf(wrapped) >>> 0);
      expect(Number(input.additionalAuthenticatedDataCrc32c?.value)).toBe(crc32c.buf(aad) >>> 0);
      const stored = wrappedKeys.get(wrapped.toString("base64"));
      if (!stored || !stored.aad.equals(aad) || stored.key !== input.name) return fail(3);
      if (state.disabledVersions.has(stored.version)) fail(9);
      const plain = Buffer.from(stored.bytes);
      returned.push(plain);
      return [{ plaintext: plain, plaintextCrc32c: { value: state.badDecryptCrc ? -1 : crc32c.buf(plain) >>> 0 } }];
    },
  };
  return { client, state, returned };
}
const pool = lazyPool(testDatabaseUrl("kms_secrets"), "kms-tests");
const kms = fakeKms([KEY, NEXT_KEY]);
const store = (keyName = KEY, decryptKeyNames: string[] = []) =>
  kmsPostgresStore({ company: "acme", keyName, decryptKeyNames, kms: kms.client, database: () => pool.db() });
const address = () => ({ namespace: "testing", path: randomUUID() });
beforeAll(async () => {
  await (await pool.db()).query(KMS_SECRETS_SQL);
});
afterAll(async () => {
  await pool.close();
});

describe("KMS encrypted Postgres", () => {
  it("uses unsigned Castagnoli checksums matching the published check vector", () => {
    expect(crc32c.buf(Buffer.from("123456789")) >>> 0).toBe(0xe3069283);
  });
  it("passes atomic store conformance using real Postgres and scoped KMS transport", async () => {
    expect((await checkSecretStore(store(), randomUUID())).filter((c) => !c.ok)).toEqual([]);
  });
  it("surfaces denied access without provider payloads", async () => {
    kms.state.denied = true;
    try {
      await expect(store().validate("testing")).rejects.toMatchObject({
        code: "denied",
        message: "Secret store: denied",
      });
    } finally {
      kms.state.denied = false;
    }
  });
  it("persists only ciphertext, zeroes returned data keys and makes fresh decrypt calls after revocation", async () => {
    const at = address(),
      s = store();
    await s.write(at, "synthetic-private-token", { expectedVersion: null, by: "alice" });
    const row = await (await pool.db()).query("SELECT * FROM sanoma_kms.secrets WHERE path=$1", [at.path]);
    expect(JSON.stringify(row.rows)).not.toContain("synthetic-private-token");
    expect((await store().read(at))?.value).toBe("synthetic-private-token");
    expect(kms.returned.every((key) => key.every((byte) => byte === 0))).toBe(true);
    kms.state.denied = true;
    try {
      await expect(s.read(at)).rejects.toMatchObject({ code: "denied" });
    } finally {
      kms.state.denied = false;
    }
  });
  it.each(["ciphertext", "nonce", "tag", "wrapped", "format", "key", "keyVersion"])(
    "rejects tampered %s",
    async (field) => {
      const at = address();
      await store().write(at, "value", { expectedVersion: null, by: "alice" });
      await (
        await pool.db()
      ).query("UPDATE sanoma_kms.secrets SET envelope=jsonb_set(envelope,ARRAY[$2],to_jsonb($3::text)) WHERE path=$1", [
        at.path,
        field,
        field === "format"
          ? "v99"
          : field === "keyVersion"
            ? `${KEY}/cryptoKeyVersions/2`
            : Buffer.alloc(16, 9).toString("base64"),
      ]);
      await expect(store().read(at)).rejects.toMatchObject({ code: "invalid_value" });
    },
  );
  it("authenticates path, namespace, company and row version", async () => {
    for (const field of ["path", "namespace", "company", "version"] as const) {
      const at = address();
      await store().write(at, "value", { expectedVersion: null, by: "alice" });
      const changed = randomUUID();
      await (await pool.db()).query(`UPDATE sanoma_kms.secrets SET ${field}=$2 WHERE path=$1`, [at.path, changed]);
      const reading =
        field === "company"
          ? kmsPostgresStore({ company: changed, keyName: KEY, kms: kms.client, database: () => pool.db() })
          : store();
      const target = {
        ...at,
        ...(field === "path" ? { path: changed } : {}),
        ...(field === "namespace" ? { namespace: changed } : {}),
      };
      await expect(reading.read(target)).rejects.toMatchObject({
        code: "invalid_value",
      });
    }
  });
  it("supports restart and explicit key replacement while retaining old keys for recovery", async () => {
    const at = address(),
      first = await store().write(at, "recoverable", { expectedVersion: null, by: "alice" });
    const rotated = store(NEXT_KEY, [KEY]);
    expect((await rotated.read(at))?.value).toBe("recoverable");
    const next = await rotated.write(at, "recoverable", { expectedVersion: first.version, by: "rotation" });
    expect(next.version).not.toBe(first.version);
    expect((await store(NEXT_KEY).read(at))?.value).toBe("recoverable");
    await expect(store().read(at)).rejects.toMatchObject({ code: "invalid_value" });
    await expect(rotated.write(at, "stale", { expectedVersion: first.version, by: "rotation" })).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("never truncates bundles and rejects malformed or version-specific key configuration", async () => {
    expect(() =>
      kmsPostgresStore({
        company: "acme",
        keyName: `${KEY}/cryptoKeyVersions/1`,
        kms: kms.client,
        database: () => pool.db(),
      }),
    ).toThrow("invalid_configuration");
    await expect(
      store().write(address(), "x".repeat(65537), { expectedVersion: null, by: "alice" }),
    ).rejects.toMatchObject({ code: "too_large" });
    const at = address(),
      value = "x".repeat(65536);
    await store().write(at, value, { expectedVersion: null, by: "alice" });
    expect((await store().read(at))?.value).toBe(value);
  });
  it("denies another company's valid wrapped key even with its correct AAD", async () => {
    const other = fakeKms([OTHER_KEY]);
    const plaintext = randomBytes(32),
      aad = Buffer.from("known other-company context");
    const [encrypted] = await other.client.encrypt({
      name: OTHER_KEY,
      plaintext,
      plaintextCrc32c: { value: crc32c.buf(plaintext) >>> 0 },
      additionalAuthenticatedData: aad,
      additionalAuthenticatedDataCrc32c: { value: crc32c.buf(aad) >>> 0 },
    });
    plaintext.fill(0);
    await expect(
      kms.client.decrypt({
        name: OTHER_KEY,
        ciphertext: encrypted.ciphertext,
        ciphertextCrc32c: encrypted.ciphertextCrc32c,
        additionalAuthenticatedData: aad,
        additionalAuthenticatedDataCrc32c: { value: crc32c.buf(aad) >>> 0 },
      }),
    ).rejects.toMatchObject({ code: 7 });
    await expect(
      kmsPostgresStore({ company: "other", keyName: OTHER_KEY, kms: kms.client, database: () => pool.db() }).validate(
        "test",
      ),
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("does not claim AAD or a successful validate proves company isolation", async () => {
    // The same identity can use its permitted key with arbitrary AAD, including another company ID.
    // Provisioning must not grant multiple companies access to one key in this direct-runtime model.
    await expect(
      kmsPostgresStore({ company: "other", keyName: KEY, kms: kms.client, database: () => pool.db() }).validate("test"),
    ).resolves.toBeUndefined();
  });
  it("survives primary-version rotation and requires old versions for old rows/backups", async () => {
    const at = address();
    const first = await store().write(at, "before rotation", { expectedVersion: null, by: "alice" });
    const {
      rows: [backup],
    } = await (await pool.db()).query("SELECT * FROM sanoma_kms.secrets WHERE path=$1", [at.path]);
    kms.state.primary = 2;
    try {
      expect((await store().read(at))?.value).toBe("before rotation");
      await store().write(at, "after rotation", { expectedVersion: first.version, by: "alice" });
      const {
        rows: [current],
      } = await (await pool.db()).query("SELECT envelope FROM sanoma_kms.secrets WHERE path=$1", [at.path]);
      expect(current.envelope.keyVersion).toBe(`${KEY}/cryptoKeyVersions/2`);
      kms.state.disabledVersions.add(1);
      expect((await store().read(at))?.value).toBe("after rotation");
      await (
        await pool.db()
      ).query("UPDATE sanoma_kms.secrets SET envelope=$2,version=$3 WHERE path=$1", [
        at.path,
        backup.envelope,
        backup.version,
      ]);
      await expect(store().read(at)).rejects.toMatchObject({ code: "invalid_configuration" });
      kms.state.disabledVersions.clear();
      expect((await store().read(at))?.value).toBe("before rotation");
    } finally {
      kms.state.primary = 1;
      kms.state.disabledVersions.clear();
    }
  });
  it.each(["badEncryptCrc", "unverified", "wrongName"] as const)(
    "refuses to persist an invalid KMS encryption response: %s",
    async (flag) => {
      const at = address();
      kms.state[flag] = true;
      try {
        await expect(store().write(at, "value", { expectedVersion: null, by: "alice" })).rejects.toMatchObject({
          code: "invalid_value",
        });
        expect(await store().read(at)).toBeUndefined();
        expect(kms.returned.every((key) => key.every((v) => v === 0))).toBe(true);
      } finally {
        kms.state[flag] = false;
      }
    },
  );
  it("rejects corrupt returned plaintext data keys and clears their buffers", async () => {
    const at = address();
    await store().write(at, "value", { expectedVersion: null, by: "alice" });
    kms.state.badDecryptCrc = true;
    try {
      await expect(store().read(at)).rejects.toMatchObject({ code: "invalid_value" });
      expect(kms.returned.every((key) => key.every((v) => v === 0))).toBe(true);
    } finally {
      kms.state.badDecryptCrc = false;
    }
  });
});
