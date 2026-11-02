# GCP KMS-protected credential storage

`@sanoma-ai/workflows/kms-secrets` implements the managed Cloud storage adapter from #470. Encrypted credentials live in **Postgres**, in `sanoma_kms.secrets` in the company database supplied by trusted bootstrap. Supabase can host that Postgres database; no separate key-value database is needed. GCP KMS protects encryption keys, not the credential records. BYOC Supabase Vault is a separate adapter. AWS Secrets Manager remains deferred.

## Runtime boundary

One company runs in one process with its own database authority and **GCP identity permitted to use only that company's CryptoKeys**. Trusted deployment bootstrap supplies the fixed company ID, CryptoKey resource name, SDK client and database connection. Never give company code fleet-wide decrypt authority or an administrator database connection. A company's code and installed connectors can use its authorized credentials; encryption does not protect those credentials from its own compromised runtime.

The proposed default is one symmetric SOFTWARE CryptoKey per company and environment, with keys grouped in a shared environment key ring/project. HSM protection is an independent provisioning choice, with different pricing; per-company software keys do not imply HSM protection. Separate production and test identities, keys and databases.

This adapter is not a production Cloud deployment. D1 implementation is tracked in [#492](https://github.com/Sanoma-AI/sanoma/issues/492) and [PR #496](https://github.com/Sanoma-AI/sanoma/pull/496). Isolated live IAM tests have passed; intended-host deployment and rollout checks remain separate. A Cloudflare deployment does not automatically have a Google identity. Workload Identity Federation or another approved refreshable credential route must bind the authenticated workload to its company; tenant code cannot select or impersonate other companies. The adapter provisions no identities, keys, database grants or shared service.

Privileged deployment setup installs `KMS_SECRETS_SQL` once in the company database and grants the runtime `USAGE` on `sanoma_kms` and `SELECT/INSERT/UPDATE/DELETE` on `sanoma_kms.secrets`. The store does not install its schema or grant permissions during startup.

In deployment configuration, `managedKmsStore` composes the runtime identity broker and KMS transport with the runtime's existing company database:

```ts
import { defineConfig } from "sanoma";
import { managedKmsStore } from "sanoma/secrets";

// Prepare the database first with sanoma.secretStore.prepare (below).
// companyDatabaseUrl is the resulting restricted runtime URL.

export default defineConfig({
  connectors: [],
  databaseUrl: companyDatabaseUrl,
  secrets: {
    namespace: "production",
    store: managedKmsStore({
      company: companyIdFromTrustedBootstrap,
      keyName: "projects/cloud-project/locations/us-central1/keyRings/production/cryptoKeys/company-id",
      identity: {
        endpoint: "https://identity.example.com/token",
        credential: async () => readProtectedDeploymentCredential(),
      },
    }),
  },
});
```

The company ID, key reference, broker endpoint and credential reader come from trusted deployment bootstrap. `credential` reads the current bearer value from protected host configuration and is called again when the short-lived Google token needs renewal. It must not read that value from the store it unlocks. Optional `decryptKeyNames` allows retained company keys during replacement or backup recovery. The helper is also exported by `@sanoma-ai/workflows/kms-secrets`; `sanoma/secrets` makes it available to company repos that install only `sanoma` and their connectors.

`managedKmsStore` returns a `SecretStoreFactory`: non-secret `id` and capabilities plus `create({ database })`. The runtime binds a fresh adapter to its own database connection for each access context. Each bound managed adapter opens its SDK client lazily and owns its refreshed-token state; runtime shutdown closes that client. Reusing a configuration does not rebind an earlier instance to another database. Configuration descriptions inspect metadata without querying the broker, KMS or Postgres; startup validates the selected store.

Factory construction must perform no I/O or allocate clients needing cleanup, and the returned adapter must preserve its declared ID and capabilities. An adapter that opens clients lazily may return `close()` for the runtime to call; it must never close the supplied database connection. A factory must be bound by the runtime before use; it cannot be passed directly to `SecretAccess` or the store conformance checker. A caller-supplied `SecretStore` remains caller-owned.

For standalone use or an explicitly supplied KMS client, use the lower-level `kmsPostgresStore`:

```ts
import { KeyManagementServiceClient } from "@google-cloud/kms";
import { kmsPostgresStore } from "@sanoma-ai/workflows/kms-secrets";

const kms = new KeyManagementServiceClient({ authClient: companyAuthClient });
const store = kmsPostgresStore({
  company: companyIdFromTrustedBootstrap,
  keyName: companyKeyName,
  kms,
  database: async () => companyDatabase,
});
await store.validate("production");
```

An explicit `database` returns a `SecretStore`; omitting it returns a factory that uses the runtime's database. In both forms of `kmsPostgresStore`, the caller owns the supplied KMS client, including `kms.close()`. An explicit database connection is also caller-owned. `managedKmsStore` supplies both the runtime binding and SDK lifecycle instead.

`SANOMA_SIGNING_KEY` stays independent. This store does not use `SANOMA_SECRETS_KEY`. Workflow code cannot import either backend entry. Secret intake must remain outside durable workflow inputs/outputs. Runtime binding does not establish deployed Cloud readiness; provisioning, bootstrap delivery and live company isolation remain #532 verification work.

## Preparing the company database

The built-in `sanoma.secretStore.prepare` operation initializes an existing, dedicated company/environment Postgres database. It installs the private KMS schema, creates a restricted runtime login, saves that login's URL in the provisioning runtime's selected secret store, and returns only `{ company, environment, role, store }`. It does not create the database or the GCP key. Use it in a provisioning workflow:

```ts
import { defineWorkflow, sanoma } from "sanoma";
import { z } from "zod";

export const prepareStorage = defineWorkflow({
  name: "prepare-managed-storage",
  trigger: "manual",
  input: z.object({}),
  uses: [sanoma.secretStore.prepare],
  run: async (ctx) =>
    await ctx.sanoma.secretStore.prepare({
      company: "acme",
      environment: "production",
      database: { $secret: "SANOMA_DATABASE_URL_CLOUD_ACME" },
      store: "CLOUD_ACME_DATABASE_URL",
    }),
});
```

The source secret names a privileged provisioning URL for that database: its login must be able to install the schema, create roles and grant database/schema privileges. Keep it in the selected secret store; neither the URL nor its password belongs in workflow input. The destination must be a different, writable secret name outside the reserved `SANOMA_` prefix. Supply `CLOUD_ACME_DATABASE_URL` to the host through a secret reference; never give the company runtime the source administrator URL. Remote connections require certificate-verified TLS (`sslmode=verify-full`); loopback databases support local development. URL query options that can override connection authority are refused.

This is an `access` operation, evaluated under policy and recorded in the ledger; direct calls are refused. Its database work runs inside the trusted driver boundary. The runtime URL is saved before database mutation, so retries after an uncertain outcome retain the same password. A transaction serializes preparation and binds the database immutably to company, environment, role and a credential hash in `sanoma_kms.deployment`. A conflicting binding, destination or pre-existing unowned role is refused. This operation neither adopts existing credentials nor rotates a database password; keep its saved runtime URL for retries and recovery.

Preparation removes public grants from the target database and its `public` schema. The runtime receives `CONNECT`, `CREATE` and `TEMPORARY` on its own database, plus `USAGE`/`CREATE` on `public`, so Sanoma can initialize its DBOS and application schemas. It receives only `USAGE` on `sanoma_kms` and `SELECT`/`INSERT`/`UPDATE`/`DELETE` on `sanoma_kms.secrets`. It cannot administer roles or databases, own the database or KMS schema, or access the private deployment binding. Unexpected role privilege drift is refused on retry. Use a dedicated database; preparation changes its access grants.

Success verifies the stored login and its KMS-table permissions. It means **database initialized**, not **managed storage ready**: GCP key/IAM provisioning, refreshable runtime identity, host secret delivery, KMS validation and a deployed credential read/write still need their own checks. A sandbox run uses isolated in-memory bindings and makes no database connections. It cannot establish Postgres or live IAM readiness.

## One shared key versus a key per company

| Event                                                   | One shared CryptoKey                                                                                                        | Per-company CryptoKeys with scoped identities                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Database backup stolen without KMS authority            | Encrypted credentials remain protected                                                                                      | Same protection                                                                                               |
| Company A runtime identity compromised                  | If it can call the shared key directly, that grant also authorizes decryption of B's ciphertext when available with its AAD | A's key grant cannot decrypt B's ciphertext under B's key                                                     |
| Fleet decrypt identity or IAM administrator compromised | Fleet exposure                                                                                                              | Fleet exposure still possible; separate keys cannot fix broad credentials or an attacker able to grant access |
| Disable a company or respond to an incident             | Key disable affects everyone; tenant access needs a broker/policy boundary                                                  | Revoke the company's identity or disable its key versions independently                                       |
| Destroy keys after retention ends                       | Shared key versions cannot be destroyed while any company still needs them                                                  | Independent company retention; all versions/copies/backups must be accounted for                              |
| Rotation and audits                                     | Shared lifecycle; attribution relies on identities and application records                                                  | Separate key lifecycle and key resource in audit events; configure appropriate audit logging                  |

```mermaid
flowchart LR
  A[Company A runtime identity] --> KA[GCP CryptoKey A]
  A --> PA[Company A Postgres encrypted rows]
  B[Company B runtime identity] --> KB[GCP CryptoKey B]
  B --> PB[Company B Postgres encrypted rows]
```

A shared key can be safe behind a trusted broker that independently authorizes every company request and keeps shared-key permission out of company runtimes. That broker is a different architecture and is not implemented here. In the direct-runtime design, use per-company CryptoKeys and grant `roles/cloudkms.cryptoKeyEncrypterDecrypter` on those keys only. Avoid inherited project/key-ring grants and permissions to change IAM or impersonate other identities. [GCP IAM](https://cloud.google.com/kms/docs/iam) defines these resource boundaries.

GCP additional authenticated data (AAD) protects ciphertext binding; it is **not tenant authorization**. Unlike an AWS policy conditioned on encryption context, this GCP design does not claim an IAM restriction on the company string in AAD. A caller with permission to decrypt a shared key can supply another company's known AAD. See [GCP AAD](https://cloud.google.com/kms/docs/additional-authenticated-data).

`validate` checks an own-key encryption/decryption round trip and database schema access. It cannot certify that the identity lacks permission on every other company's key. Deployment evidence must inspect grants and prove cross-company denial using existing keys, including inherited permissions. The live test checks encrypt/decrypt denial in both directions between two test identities.

The database login must separately prevent cross-company access. The company column and key allowlist are defense in depth, not a replacement for database permissions or IAM. The SQL installer uses a private schema and removes public/API-role grants; never expose it through a browser Data API. Keep database/SDK payloads and credentials out of tracing and logs.

## Envelope format and rotation

Each independent secret or atomic token bundle occupies one row. `sanoma-gcp-kms-v1` generates a fresh random 256-bit data key locally for each write attempt. AES-256-GCM encrypts the value; GCP `Encrypt` wraps only the data key using the CryptoKey's primary version. Postgres stores the ciphertext, nonce, tag, wrapped data key, CryptoKey and version names, and an opaque UUID revision for compare-and-swap updates.

Both GCP AAD and local AES-GCM bind company, namespace, path, row revision and format. AES-GCM also authenticates the returned CryptoKeyVersion name. Reads accept only configured CryptoKeys. RPCs send CRC32C checksums and verify response integrity, including the version resource returned by encryption. Provider errors become sanitized store error codes. See Google's [encryption API](https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt) and [integrity guidance](https://cloud.google.com/kms/docs/data-integrity-guidelines).

Values larger than 65,536 UTF-8 bytes are rejected. No plaintext or data-key cache is kept. Temporary mutable key buffers are cleared in `finally`; JavaScript strings and SDK-internal copies cannot be guaranteed erased. CAS conflicts leave committed values intact. Deleting a row does not revoke its vendor token or erase copies in backups.

There are three different rotations:

- **KMS version rotation:** a new primary version under the same CryptoKey. After the primary change propagates, new writes use it; existing rows still decrypt through their original enabled versions, without configuration changes. Automatic rotation does not rewrite old rows.
- **CryptoKey replacement:** change `keyName` and retain old company keys in `decryptKeyNames`. Read and rewrite old rows with their expected versions; conflict means reread rather than overwrite. This draft supports those primitives, not an automatic migration worker. Backups may still need the old keys.
- **Vendor credential rotation:** obtain a new API key or refresh an OAuth token, then save the new value. KMS rotation does not rotate vendor credentials or remove a compromised runtime's access.

Recovery needs database backups plus every enabled key version needed by retained envelopes. Test restores before retiring keys. Rewriting current rows is insufficient if retained backups contain old envelopes. Disabling is reversible but makes dependent ciphertext unreadable; destruction is irreversible after the provider's destruction window. AAD/version binding detects substitution, but does not prevent an authorized database writer from rolling back a complete old valid row; CAS assumes trusted database state. [GCP rotation](https://cloud.google.com/kms/docs/key-rotation).

## Rotation costs

GCP bills retained key **versions**, not just logical keys. Current list pricing is about $0.06 per SOFTWARE symmetric version per month, or $1 per HSM symmetric version; encrypt/decrypt operations cost $0.03 per 10,000. Creating a rotation is free. Enabled, disabled and scheduled-for-destruction versions all count until destroyed; partial months are prorated. [GCP pricing](https://cloud.google.com/kms/pricing).

| Retained versions per key | One shared SOFTWARE key | 1,000 company SOFTWARE keys | 1,000 company HSM keys |
| ------------------------- | ----------------------: | --------------------------: | ---------------------: |
| 1                         |             $0.06/month |                   $60/month |           $1,000/month |
| 2                         |             $0.12/month |                  $120/month |           $2,000/month |
| 5                         |             $0.30/month |                  $300/month |           $5,000/month |

These examples exclude operations, database costs, free-tier eligibility and replicas. One million symmetric KMS operations adds $3. Each store write attempt uses one encryption operation; each successful credential read requires one decryption. Validation uses both. Rewriting an existing row uses a read plus a write, so two operations before retries: $6 per million rows, plus database/compute work. A future data-key rewrap also requires decrypt/encrypt calls but is not implemented. Five retained versions could mean an initial version plus four rotations; this is an example, not a retention recommendation. Retention follows credential and backup recovery requirements.

## Verification

Focused tests use real local Postgres and AES-GCM with a GCP transport/IAM model. They cover atomic store conformance, tampering, checksums, key revocation, key replacement, primary-version rotation and restoration of old rows. They explicitly show that AAD cannot substitute for IAM.

The opt-in live suite requires two pre-provisioned test CryptoKeys and separate identities, each authorized only on its own key. Configure `SANOMA_GCP_KMS_LIVE=1`, `SANOMA_GCP_KMS_LIVE_KEY`, `SANOMA_GCP_KMS_LIVE_OTHER_KEY`, `SANOMA_GCP_KMS_LIVE_CREDENTIALS` and `SANOMA_GCP_KMS_LIVE_OTHER_CREDENTIALS`; the latter two name ignored SDK credential/federation configuration files. Use the isolated `SANOMA_TEST_DATABASE_URL` and run `pnpm vitest run packages/workflows/test/kms-secrets-live.test.ts`.

The suite creates no cloud resources and cleans only its own synthetic Postgres rows. Its positive checks prevent nonexistent/disabled keys from masquerading as an isolation proof. Local modeled tests do not establish real IAM isolation.

Live verification on `sanoma-513217` passed at `c3c293d0bc48cbcf66adf8e0cb0c57f500e686bc`: store conformance and two-way encrypt/decrypt denial between two existing company keys under distinct scoped identities. A separate run also proved production/preview denial in both directions. Positive own-key operations passed before each negative check. The local SDK used explicit service-account impersonation through the administrator’s OAuth session, with no service-account private keys. A separate temporary Cloud Run broker proof exercised the SDK/store against remote company databases, cross-key denials and KMS primary-version rotation: old ciphertext remained readable and new writes adopted the new primary after propagation. These are isolated synthetic resources, not a managed-hosting rollout; runtime renewal and production deployment evidence belong to D1.
