# @sanoma-ai/connector-gcp

Google Cloud KMS, IAM and Cloud Run provisioning through the pinned `hashicorp/google` **8.7.0** OpenTofu provider and isolated [bridge sessions](../../packages/bridge/README.md). This connector provisions infrastructure; it does not store credentials or supply the managed Cloud runtime's identity broker ([D1, #492](https://github.com/Sanoma-AI/sanoma/issues/492)).

The Google Cloud logo is the [official homepage asset](https://www.gstatic.com/cgc/google-cloud-logo-fullcolor.svg). Provider schema provenance and its verified download pin are recorded in `testdata/`; the provider binary is downloaded separately by the bridge.

## Resource types

| Constructor                    | Provider resource                            | Identity (import ID)                                                                    |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `gcp.keyRing`                  | `google_kms_key_ring`                        | `projects/<project>/locations/<location>/keyRings/<name>`                               |
| `gcp.cryptoKey`                | `google_kms_crypto_key`                      | `<key_ring>/cryptoKeys/<name>`                                                          |
| `gcp.keyIamMember`             | `google_kms_crypto_key_iam_member`           | `<crypto_key_id> <role> <member> [condition title]`                                     |
| `gcp.serviceAccount`           | `google_service_account`                     | `projects/<project>/serviceAccounts/<account_id>@<project>.iam.gserviceaccount.com`     |
| `gcp.serviceAccountIamMember`  | `google_service_account_iam_member`          | `<service_account_id> <role> <member> [condition title]`                                |
| `gcp.workloadIdentityPool`     | `google_iam_workload_identity_pool`          | `projects/<project>/locations/global/workloadIdentityPools/<pool>`                      |
| `gcp.workloadIdentityProvider` | `google_iam_workload_identity_pool_provider` | `projects/<project>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` |
| `gcp.customRole`               | `google_project_iam_custom_role`             | `projects/<project>/roles/<role_id>`                                                    |
| `gcp.auditConfig`              | `google_project_iam_audit_config`            | `<project> <service>`                                                                   |
| `gcp.cloudRunService`          | `google_cloud_run_v2_service`                | `projects/<project>/locations/<location>/services/<name>`                               |
| `gcp.cloudRunServiceIamMember` | `google_cloud_run_v2_service_iam_member`     | `<name> <role> <member> [condition title]`                                              |

The resource schemas are generated from the recorded provider schema; field names retain Google's provider spelling. Each type exposes read/import/plan and the apply workflow's create/update/delete operations.

Each declaration is named by its provider import ID, built from its declared fields, so `project` (and `location` where the ID has one) must be declared: a declaration without them is refused rather than defaulted. A first apply imports each unbound declaration by that ID. When Google already has the object, apply binds it instead of creating a second one; the ID is the provider's state `id` for every type except the three IAM member types and the audit config, whose binding IDs are their import IDs. A Cloud Run service's IAM member names the service by its full resource name, which a reference to a declared `gcp.cloudRunService` gives. KMS key-ring/key deletion is refused, key replacement is refused during update, and key configuration uses `deletion_policy: "PREVENT"`. Retiring a key requires a separate retention procedure covering every encrypted value and recoverable backup. The driver refuses a desired purpose other than `ENCRYPT_DECRYPT` or an algorithm other than `GOOGLE_SYMMETRIC_ENCRYPTION`; signing and asymmetric keys are outside this connector’s scope.

## Deployment identity

A live call provisions as one identity, declared in code with `gcpWithIdentity`: the project, its number, the provisioning service account, the workload identity provider's audience and the [provisioning identity service](../../packages/workflows/CLOUD-IDENTITY.md#provisioning-identity-from-a-non-google-host)'s `/identity` endpoint. None of these is secret. The one secret is the provisioning bearer that the identity service enrolled for this control plane. It is the connection's stored credential, entered on the Google Cloud connector page like an API key, and never an environment variable.

```ts
// sanoma.config.ts
import { defineConfig, defineConnection } from "sanoma";
import { secret } from "sanoma/resources";
import { gcpWithIdentity } from "@sanoma-ai/connector-gcp";

const gcp = gcpWithIdentity({
  project: "example-company",
  projectNumber: "123456789012",
  serviceAccount: "provisioner@example-company.iam.gserviceaccount.com",
  audience:
    "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/provision/providers/google",
  issuer: "https://provisioning.example.test/identity",
});
const provisioning = defineConnection(gcp, {
  name: "provisioning",
  method: "workloadIdentity",
  credentials: secret("GCP_PROVISIONING_AUTH"),
  account: "provisioner@example-company.iam.gserviceaccount.com/example-company/123456789012",
});

export default defineConfig({ connectors: [gcp], connections: [provisioning] });
```

The identity's facts live on the connector rather than in the stored bundle, so changing the project, account, audience or issuer is a reviewed code change. The connection's `account` pins the service account, project and number: verification returns that account, and a binding made for another one is refused as `wrong_account` until it is connected again. All of a config's GCP connections share the one declared identity; each can hold its own bearer. A declaration's `project` is that project's ID, never its number. The exported bare `gcp` declares no identity: use it for workflows, resources and sandbox runs, where every live verification and call is refused.

**Connect** on the connector page takes the bearer (43 base64url characters) and verifies it before saving. Verification asks the issuer for one Google OIDC token, exchanges it at Google STS for the declared audience and impersonates the declared service account. Success proves the bearer is enrolled and trusted for exactly that account. The connection stores only `{ bearer }`; **Replace credentials** stores a new one, which the next call uses.

Each authorized call reads its bundle through `authenticationCredentials` inside that call, builds the external-account configuration in memory and gives it to a fresh provider session. The configuration fixes Google STS, a JWT subject token from the issuer URL and impersonation of the declared account for ten-minute access tokens. It cannot express a service-account key, an executable or file source, or ambient ADC, and nothing falls back to another identity. Failures are sanitized: no SDK message, cause or token crosses the boundary. Verification returns the account and an empty scope list, not the access token or an attestation of individual IAM grants. Google IAM remains authoritative for permissions.

The driver also checks project IDs and numbers in resource identifiers and fields against the declared identity. Those checks do not replace IAM isolation: grant the provisioning account only what its declarations need, and give company runtimes different service accounts and roles.

A running provider session holds the bearer it started with while it renews from the issuer, so a replaced bearer needs enough overlap for active operations to finish before the old enrollment is retired. Stopping an enrollment does not invalidate Google OIDC tokens already issued, which last up to one hour: remove federation or impersonation trust as part of incident revocation. Company runtimes use the separate runtime broker and never receive the provisioning bearer.

### First administrator setup

Sanoma cannot provision the trust it provisions through, so an administrator sets up the first identity by hand, with an existing authorized administration path:

1. Create the project, enable billing and the IAM, IAM Credentials, STS, KMS and Cloud Run APIs. This connector has no project, billing or API-enablement resource ([#698](https://github.com/Sanoma-AI/sanoma/issues/698)).
2. Create the three service accounts the [provisioning identity service](../../packages/workflows/CLOUD-IDENTITY.md#provisioning-identity-from-a-non-google-host) separates: the issuer's attached account, the source account it mints OIDC tokens for, and the provisioning account. Grant the issuer `iam.serviceAccounts.getOpenIdToken` on the source account only.
3. Create the workload identity pool and an OIDC provider for issuer `https://accounts.google.com`, mapping `google.subject` from `assertion.sub` with a condition on the source account's numeric `uniqueId` and the audience. Grant that principal `roles/iam.workloadIdentityUser` on the provisioning account. Grant the provisioning account only the KMS and IAM administration its declarations need.
4. Install the enrollment and audit schemas, deploy the identity service in `provisioning` mode, and enroll the control plane's first bearer: `createDeploymentCredential()` from `@sanoma-ai/workflows/cloud-identity` returns `{ credential, hash }`; insert the hash with administrative authority and keep the credential only until the next step. An operation for this enrollment and its rotation is [#701](https://github.com/Sanoma-AI/sanoma/issues/701).
5. Paste the credential into **Connect** on the Google Cloud connector page for the `provisioning` connection.

Once that trust works, declare these objects in a data file and let apply manage them: a first apply binds the existing ones by their import IDs instead of creating them again. The connector requires a nonempty OIDC trust condition on every `workloadIdentityProvider`; it does not infer the right condition for you.

## Authoring resources

```ts
// resources/gcp.ts
import { gcp } from "@sanoma-ai/connector-gcp/resources";

const connection = { vendor: "gcp", $connection: "gcp/provisioning" } as const;
export const ring = gcp.keyRing(
  { project: "example-company", location: "us-central1", name: "company-secrets" },
  { connection },
);
export const key = gcp.cryptoKey(
  {
    name: "production",
    key_ring: ring,
    purpose: "ENCRYPT_DECRYPT",
    version_template: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION", protection_level: "SOFTWARE" },
    deletion_policy: "PREVENT",
  },
  { connection },
);
```

Grant runtime encrypt/decrypt access with `keyIamMember` on the specific key. Keep production and preview identities separate. Rotation creates new key versions; it does not by itself re-encrypt stored ciphertext or retire versions needed by backups. This provisioning surface is separate from the credential-storage adapter in [#470](https://github.com/Sanoma-AI/sanoma/issues/470).

### IAM member IDs

For `keyIamMember`, `serviceAccountIamMember` and `cloudRunServiceIamMember`, the public operation result's `id` is the provider's import identifier:

```text
resource_name role member [condition_title]
```

Pass that returned `id` unchanged to a subsequent read, including when no saved provider state is available. Sanoma derives it from the structured parent resource, role, member and optional condition title. Custom role paths and `principal://` members retain their slashes. The provider's native `state.id` remains unchanged; its slash-delimited representation is not the import identifier. See the pinned provider's [IAM member import implementation](https://github.com/hashicorp/terraform-provider-google/blob/v8.7.0/google/tpgiamresource/resource_iam_member.go).

Google 8.7.0 reports an absent IAM member as an import error after reading its parent's policy. For these three IAM types, Sanoma recognizes only that specific missing-binding diagnostic as absence: reads return `gone: true`, provisioning can read before creating a grant, and deleting an already absent grant is idempotent. Permission failures, ambiguous conditions and other diagnostics remain sanitized errors.

## Testing and current evidence

`fakeGcp` is the bridge's in-memory resource fake; it is not Google IAM or a federation server. Authentication tests use a synthetic issuer, STS and IAM: verification of a stored bearer, a replaced bearer on the next verification, missing or malformed bundles, unenrolled bearers, denied impersonation, rejected identity facts and sanitized failures. Driver tests use a provider state double to check concurrent session separation, project/account refusals, symmetric-key and retention guards, OIDC condition requirements, sanitized failures and the fake. The recorded schema/pin in `testdata/` establishes the generated provider contract, not a successful cloud deployment.

The [isolated live run](https://github.com/Sanoma-AI/sanoma/actions/runs/41164779676) passed on `e43fb77c1e05d51838687d4574b2678218983386` in project `sanoma-513217`: GitHub OIDC → WIF → scoped provisioning account, denied impersonation of another existing account, real Google-provider key create/read/update, rotation-period update and key-deletion refusal. One provider session remained active for 660 seconds and fetched a fresh OIDC subject token after its ten-minute impersonated token expired. Trust was restricted to numeric repository/owner IDs, branch, workflow and the exact reviewed commit. This proves that provisioning path; it does not establish live CRUD for every resource type or a company runtime's identity. That run used a GitHub Actions OIDC source, which the connector no longer accepts: the identity service's issuer is now the only subject-token source, and a live run through it is still to be recorded.

A later published-package workflow under [#532](https://github.com/Sanoma-AI/sanoma/issues/532) created a key ring, service account, crypto key and both IAM member types, then exposed a failure when reading an IAM member by its returned ID. The connector now derives importable public IDs while preserving native provider state. Synthetic regression coverage checks custom roles, `principal://` members, optional conditions and reads by returned ID without saved state. A successful live rerun of the full provisioning graph remains pending.

The next published run passed those ID reads, then stopped while importing a grant that did not exist. A separate live read reproduced the provider's missing-binding diagnostic. The corrected unpublished driver then passed live absent-member reads and idempotent deletion for both IAM types against the existing disposable resources. A published rerun of the full provisioning graph remains pending.

`test/live.test.ts` is run by hand, never in CI. An administrator sets `SANOMA_GCP_PROVISION_LIVE=1` and the test's own configuration: `SANOMA_GCP_LIVE_PROJECT`, `_PROJECT_NUMBER`, `_PROVISIONER`, `_AUDIENCE`, `_ISSUER` (the deployed identity service's `/identity`), `_BEARER` (an enrolled provisioning bearer), `_OTHER_ACCOUNT` (an existing account the federation must not impersonate) and `_RING` (a disposable key ring). These configure the test, not a deployment. It verifies the bearer, checks denied impersonation, creates, reads and updates a synthetic key through the real provider, and keeps one provider session reading past its ten-minute token. Retire the key's versions afterwards; KMS key and ring metadata remain. Never use a production ring.

Run `pnpm vitest run connectors/gcp` and the repository's type/lint/build checks. Regenerate types with `pnpm --filter @sanoma-ai/connector-gcp generate`; update the recorded schema/pins deliberately, and never edit `resources.gen.ts` by hand. Test-map details are in [test/AGENTS.md](test/AGENTS.md).
