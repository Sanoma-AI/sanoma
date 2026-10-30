# KMS-protected credential storage

`@sanoma-ai/workflows/kms-secrets` provides the proposed managed Cloud store for #470. BYOC Supabase Vault is a separate adapter; this does not use AWS Secrets Manager. The backend implements storage, not Cloud provisioning, OAuth or cross-store migration.

## Runtime boundary

One company runs in one process with its own database authority and **company-scoped AWS identity**. Trusted deployment bootstrap supplies the fixed company ID, immutable KMS key ARN, explicit SDK client and database connection. Never supply a fleet-wide KMS identity or shared administrator database connection to a company runtime. Company code/installed connectors can use that company's authorized credentials; encryption does not protect its credentials from its own compromised runtime.

This is the direct scoped-KMS candidate for the managed runtime-trust decision (D1). Production deployment still requires reviewed identity issuance and positive/negative IAM proof in the target host. It does not assume Cloudflare provides AWS identity automatically. STS/OIDC or another approved issuer must provide refreshable credentials scoped to the specific company. No issuer, role, KMS key or shared credential service is provisioned by this adapter.

```ts
import { KMS_SECRETS_SQL, kmsPostgresStore } from "@sanoma-ai/workflows/kms-secrets";

// Trusted setup installs this once using the company's database administrator:
await adminDb.query(KMS_SECRETS_SQL);
// Grant runtime USAGE on sanoma_kms and SELECT/INSERT/UPDATE/DELETE on sanoma_kms.secrets.
const store = kmsPostgresStore({
  company: companyIdFromTrustedBootstrap,
  keyArn: immutableKeyArn,
  kms: companyScopedKmsClient,
  database: async () => companyDatabase,
});
await store.validate("production");
// Deployment config: secrets: { store, namespace: "production" }
```

The caller owns SDK/database connection lifecycle. `SANOMA_SIGNING_KEY` remains independent; `SANOMA_SECRETS_KEY` is not used by this store. No plaintext enters workflow input/output merely to transfer it to storage. Workflows cannot import this backend entry.

## IAM and database isolation

The runtime role needs `kms:GenerateDataKey` and `kms:Decrypt` on the approved key ARN(s). Enforce `kms:EncryptionContext:company` equal to the company assigned by the trusted issuer, and `kms:EncryptionContext:format` equal to `sanoma-kms-v1`. Apply these conditions to **both** operations and inspect every other policy/grant that might permit broader access. The runtime must not be able to change its role policy, company assignment, key policy or grants. Never trust a company ID supplied by a workflow or a tenant-controlled role session tag.

`validate` proves an own-company round trip, database schema access and rejection of `GenerateDataKey` under a different company context. This is an additional check, not proof of the entire IAM configuration. The live test separately verifies that the runtime cannot decrypt a valid data key minted by an administrator for another company. Live provisioning evidence remains a launch gate.

Encryption context includes logical company/namespace/path/version identifiers and appears in CloudTrail; use non-secret identifiers, never token values or private account details. Encryption context is authenticated data, **not authorization by itself**. IAM supplies authorization; the database login must independently prevent access to other companies' rows/databases. The company column is defense in depth and ciphertext binding, not a replacement for database permissions. The installer uses the private `sanoma_kms` schema and removes public/API-role grants. Never expose this schema through a Data API or grant browser roles access. Keep the table out of browser APIs, and configure database/SDK tracing so sensitive payloads and credentials are never recorded.

## Format, rotation and recovery

Each independent secret or atomic token bundle occupies one row. `sanoma-kms-v1` uses a fresh AES-256 data key from KMS for every successful or attempted write. AES-GCM authenticates company, namespace, path, credential version and format; KMS authenticates the same context when wrapping/unwrapping the data key. Postgres stores the encrypted data key, nonce, tag and ciphertext, plus an opaque UUID version and update metadata. Values up to 65,536 UTF-8 bytes are supported, including bundles larger than KMS direct-encryption limits. Oversize values are refused.

Writes use database compare-and-set; competing creates/replacements cannot silently overwrite each other. There is no plaintext or data-key cache: every read consults current storage and KMS authorization. Returned data-key buffers are zeroed in `finally`; JavaScript strings and crypto internals are not a guarantee of complete memory erasure. An already-started request can still finish after revocation.

KMS automatic rotation keeps the same key ARN and decrypts historical data keys. To replace the key resource, configure the new `keyArn` and explicitly retain old ARNs in `decryptKeyArns`, then read and rewrite each value under compare-and-set in a trusted backend maintenance process. Rewriting changes its credential version. Conflicts require rereading; never overwrite a concurrent token refresh. Remove old keys only after active rows **and retained backups** no longer need them. Aliases are refused to avoid silently changing the key selected by config.

Recovery needs the complete database rows, readable KMS keys, IAM authority and configuration. Database backup restoration alone cannot replace a deleted KMS key. Deletion removes the active row; database backups/PITR may retain ciphertext. This is not immediate cryptographic erasure, and deleting an encryption key is not a migration mechanism. Cross-store transfer/cutover remains #468.

[KMS encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html), [GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html), and [key rotation](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html) describe the provider behavior this format relies on.

## Verification

Normal tests use real isolated Postgres plus an in-process KMS transport/identity model; actual AES-GCM remains in use. They cover conformance, races, tampering, wrong company, denied access, restart/key replacement, plaintext exclusion and data-key buffer cleanup.

For actual AWS proof, explicitly provide a disposable key ARN, company, scoped AWS profile and separate administrator profile using `SANOMA_KMS_LIVE_KEY_ARN`, `SANOMA_KMS_LIVE_COMPANY`, `SANOMA_KMS_LIVE_PROFILE`, and `SANOMA_KMS_LIVE_ADMIN_PROFILE`. Set `SANOMA_KMS_LIVE=1` and run `pnpm vitest run packages/workflows/test/kms-secrets-live.test.ts` with this worktree's `SANOMA_TEST_DATABASE_URL`. Profiles must already be authenticated. The test creates no AWS resources, uses synthetic data, cleans its isolated namespace, and returns assertions only. It exercises real KMS requests and requires an admin able to mint the negative-test data key; do not use a production company/key.
