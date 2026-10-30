import { randomBytes, randomUUID } from "node:crypto";
import { KeyManagementServiceClient } from "@google-cloud/kms";
import crc32c from "fast-crc32c";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lazyPool } from "../src/db.ts";
import { KMS_SECRETS_SQL, kmsPostgresStore } from "../src/kms-secrets.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";

// Explicit opt-in, two existing disposable keys and two independently scoped identities.
// Credential files may be workload-identity federation configurations; never commit them.
// No cloud resources are created and no credentials, resource names or ciphertext are logged.
const keyName = process.env.SANOMA_GCP_KMS_LIVE_KEY;
const otherKey = process.env.SANOMA_GCP_KMS_LIVE_OTHER_KEY;
const credentials = process.env.SANOMA_GCP_KMS_LIVE_CREDENTIALS;
const otherCredentials = process.env.SANOMA_GCP_KMS_LIVE_OTHER_CREDENTIALS;
const enabled = process.env.SANOMA_GCP_KMS_LIVE === "1";
const company = `proof-${randomUUID()}`,
  namespace = "live-proof";
let kms: KeyManagementServiceClient;
let other: KeyManagementServiceClient;
let installed = false;
const pool = lazyPool(testDatabaseUrl("kms_live"), "kms-live-proof");
const rpc = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw Object.assign(new Error("KMS proof request failed"), { code: (error as { code?: number }).code });
  }
};
describe.runIf(enabled)("GCP KMS IAM proof", () => {
  beforeAll(async () => {
    if (!keyName || !otherKey || keyName === otherKey || !credentials || !otherCredentials)
      throw new Error("Missing two distinct test keys and explicit identity configurations");
    kms = new KeyManagementServiceClient({ keyFilename: credentials });
    other = new KeyManagementServiceClient({ keyFilename: otherCredentials });
    await (await pool.db()).query(KMS_SECRETS_SQL);
    installed = true;
  });
  afterAll(async () => {
    try {
      if (installed) await (await pool.db()).query("DELETE FROM sanoma_kms.secrets WHERE company=$1", [company]);
    } finally {
      await Promise.all([pool.close(), kms?.close(), other?.close()]);
    }
  });
  it("passes store conformance under the company identity", async () => {
    const store = kmsPostgresStore({ company, keyName: keyName!, kms, database: () => pool.db() });
    expect((await checkSecretStore(store, namespace)).filter((c) => !c.ok)).toEqual([]);
  }, 60_000);
  it("denies cross-company encryption and decryption in both directions, even with correct AAD", async () => {
    for (const [owner, outsider, key] of [
      [kms, other, keyName!],
      [other, kms, otherKey!],
    ] as const) {
      const plain = randomBytes(32),
        aad = Buffer.from("known-negative-proof-context");
      const request = {
        name: key,
        plaintext: plain,
        plaintextCrc32c: { value: crc32c.calculate(plain) },
        additionalAuthenticatedData: aad,
        additionalAuthenticatedDataCrc32c: { value: crc32c.calculate(aad) },
      };
      try {
        const [encrypted] = await rpc(owner.encrypt(request));
        const decryptRequest = {
          name: key,
          ciphertext: encrypted.ciphertext,
          ciphertextCrc32c: encrypted.ciphertextCrc32c,
          additionalAuthenticatedData: aad,
          additionalAuthenticatedDataCrc32c: request.additionalAuthenticatedDataCrc32c,
        };
        const [roundtrip] = await rpc(owner.decrypt(decryptRequest));
        try {
          expect(Buffer.from(roundtrip.plaintext as Uint8Array).equals(plain)).toBe(true);
        } finally {
          if (roundtrip.plaintext instanceof Uint8Array) roundtrip.plaintext.fill(0);
        }
        await expect(rpc(outsider.encrypt(request)).then(() => true)).rejects.toMatchObject({ code: 7 });
        await expect(
          rpc(outsider.decrypt(decryptRequest)).then(([response]) => {
            if (response.plaintext instanceof Uint8Array) response.plaintext.fill(0);
            return true;
          }),
        ).rejects.toMatchObject({ code: 7 });
      } finally {
        plain.fill(0);
      }
    }
  }, 60_000);
});
