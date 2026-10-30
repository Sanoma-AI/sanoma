import { randomBytes, randomUUID } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lazyPool } from "../src/db.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";
import { KMS_SECRETS_SQL, kmsPostgresStore } from "../src/kms-secrets.ts";

const KEY = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111";
const NEXT_KEY = "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-2222-2222-222222222222";
const fail = (name: string): never => {
  throw Object.assign(new Error("synthetic sensitive provider detail"), { name });
};

/** Simulates KMS transport/identity, not AES: payload encryption uses the actual implementation. */
function fakeKms(company: string) {
  const client = new KMSClient({
    region: "us-east-1",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
  });
  const keys = new Map<string, { bytes: Buffer; context: string; key: string }>();
  const returned: Uint8Array[] = [];
  const state = { denied: false, broad: false, calls: 0 };
  client.middlewareStack.add(
    () => async (args) => {
      state.calls++;
      const input = args.input as {
        EncryptionContext: Record<string, string>;
        KeyId: string;
        CiphertextBlob?: Uint8Array;
      };
      if (state.denied || (!state.broad && input.EncryptionContext.company !== company)) fail("AccessDeniedException");
      const context = JSON.stringify(input.EncryptionContext);
      if (!input.CiphertextBlob) {
        const wrapped = randomBytes(32),
          plain = randomBytes(32);
        keys.set(wrapped.toString("base64"), { bytes: Buffer.from(plain), context, key: input.KeyId });
        returned.push(plain);
        return {
          response: {},
          output: { $metadata: {}, KeyId: input.KeyId, Plaintext: plain, CiphertextBlob: wrapped },
        };
      }
      const stored = keys.get(Buffer.from(input.CiphertextBlob).toString("base64"));
      if (!stored || stored.context !== context || stored.key !== input.KeyId) fail("InvalidCiphertextException");
      const plain = Buffer.from(stored!.bytes);
      returned.push(plain);
      return { response: {}, output: { $metadata: {}, KeyId: input.KeyId, Plaintext: plain } };
    },
    { step: "initialize", name: "fakeKms" },
  );
  return { client, state, returned };
}
const pool = lazyPool(testDatabaseUrl("kms_secrets"), "kms-tests");
const kms = fakeKms("acme");
const store = (keyArn = KEY, decryptKeyArns: string[] = []) =>
  kmsPostgresStore({ company: "acme", keyArn, decryptKeyArns, kms: kms.client, database: () => pool.db() });
const address = () => ({ namespace: "testing", path: randomUUID() });
beforeAll(async () => {
  await (await pool.db()).query(KMS_SECRETS_SQL);
});
afterAll(async () => {
  kms.client.destroy();
  await pool.close();
});

describe("KMS encrypted Postgres", () => {
  it("passes atomic store conformance using real Postgres and scoped KMS transport", async () => {
    expect((await checkSecretStore(store(), randomUUID())).filter((c) => !c.ok)).toEqual([]);
  });
  it("rejects a fleet-wide identity at validation and surfaces denied access without provider payloads", async () => {
    kms.state.broad = true;
    try {
      await expect(store().validate("testing")).rejects.toMatchObject({ code: "invalid_configuration" });
    } finally {
      kms.state.broad = false;
    }
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
    expect(kms.returned.every((b) => b.every((byte) => byte === 0))).toBe(true);
    kms.state.denied = true;
    try {
      await expect(s.read(at)).rejects.toMatchObject({ code: "denied" });
    } finally {
      kms.state.denied = false;
    }
  });
  it.each(["ciphertext", "nonce", "tag", "wrapped", "format", "key"])("rejects tampered %s", async (field) => {
    const at = address();
    await store().write(at, "value", { expectedVersion: null, by: "alice" });
    await (
      await pool.db()
    ).query("UPDATE sanoma_kms.secrets SET envelope=jsonb_set(envelope,ARRAY[$2],to_jsonb($3::text)) WHERE path=$1", [
      at.path,
      field,
      field === "format" ? "v99" : Buffer.alloc(16, 9).toString("base64"),
    ]);
    await expect(store().read(at)).rejects.toMatchObject({ code: "invalid_value" });
  });
  it("authenticates path, namespace, company and row version", async () => {
    for (const field of ["path", "namespace", "company", "version"] as const) {
      const at = address();
      await store().write(at, "value", { expectedVersion: null, by: "alice" });
      const changed = randomUUID();
      await (await pool.db()).query(`UPDATE sanoma_kms.secrets SET ${field}=$2 WHERE path=$1`, [at.path, changed]);
      const reading =
        field === "company"
          ? kmsPostgresStore({ company: changed, keyArn: KEY, kms: kms.client, database: () => pool.db() })
          : store();
      const target = {
        ...at,
        ...(field === "path" ? { path: changed } : {}),
        ...(field === "namespace" ? { namespace: changed } : {}),
      };
      await expect(reading.read(target)).rejects.toMatchObject({
        code: field === "company" ? "denied" : "invalid_value",
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
  it("never truncates bundles and rejects aliases or undeclared keys", async () => {
    expect(() =>
      kmsPostgresStore({ company: "acme", keyArn: "alias/latest", kms: kms.client, database: () => pool.db() }),
    ).toThrow("invalid_configuration");
    await expect(
      store().write(address(), "x".repeat(65537), { expectedVersion: null, by: "alice" }),
    ).rejects.toMatchObject({ code: "too_large" });
    const at = address(),
      value = "x".repeat(65536);
    await store().write(at, value, { expectedVersion: null, by: "alice" });
    expect((await store().read(at))?.value).toBe(value);
  });
});
