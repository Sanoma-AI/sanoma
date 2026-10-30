import { randomUUID } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { testDatabaseUrl } from "@sanoma-ai/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lazyPool } from "../src/db.ts";
import { KMS_SECRETS_SQL, kmsPostgresStore } from "../src/kms-secrets.ts";
import { checkSecretStore } from "../src/secret-store-check.ts";

// Explicit opt-in: use a disposable test key and scoped role, plus an admin profile for negative proof.
// This test creates no AWS resources and outputs no credentials, ARNs, ciphertext or key material.
const keyArn = process.env.SANOMA_KMS_LIVE_KEY_ARN;
const company = process.env.SANOMA_KMS_LIVE_COMPANY;
const profile = process.env.SANOMA_KMS_LIVE_PROFILE;
const adminProfile = process.env.SANOMA_KMS_LIVE_ADMIN_PROFILE;
const enabled = process.env.SANOMA_KMS_LIVE === "1";
const namespace = `proof-${randomUUID()}`;
let kms: KMSClient;
let admin: KMSClient;
const pool = lazyPool(testDatabaseUrl("kms_live"), "kms-live-proof");
describe.runIf(enabled)("KMS IAM proof", () => {
  beforeAll(async () => {
    if (!keyArn || !company || !profile || !adminProfile) throw new Error("Missing explicit KMS test configuration");
    const region = keyArn.split(":")[3]!;
    kms = new KMSClient({ region, profile });
    admin = new KMSClient({ region, profile: adminProfile });
    await (await pool.db()).query(KMS_SECRETS_SQL);
  });
  afterAll(async () => {
    if (keyArn && company && profile && adminProfile) {
      await (
        await pool.db()
      ).query("DELETE FROM sanoma_kms.secrets WHERE company=$1 AND namespace IN ($2,$3)", [
        company,
        namespace,
        `${namespace}-other`,
      ]);
    }
    await pool.close();
    kms?.destroy();
    admin?.destroy();
  });
  it("passes store conformance under the scoped role", async () => {
    const store = kmsPostgresStore({ company: company!, keyArn: keyArn!, kms, database: () => pool.db() });
    expect((await checkSecretStore(store, namespace)).filter((c) => !c.ok)).toEqual([]);
  }, 60_000);
  it("denies decrypt of a valid data key belonging to another company", async () => {
    const EncryptionContext = {
      company: `other-${randomUUID()}`,
      namespace,
      path: "negative-proof",
      version: randomUUID(),
      format: "sanoma-kms-v1",
    };
    const generated = await admin.send(
      new GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: "AES_256", EncryptionContext }),
    );
    generated.Plaintext?.fill(0);
    await expect(
      kms
        .send(new DecryptCommand({ KeyId: keyArn, CiphertextBlob: generated.CiphertextBlob, EncryptionContext }))
        .then((decrypted) => {
          decrypted.Plaintext?.fill(0);
          return true;
        }),
    ).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});
