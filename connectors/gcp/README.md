# @sanoma-ai/connector-gcp

Google Cloud KMS and IAM provisioning through the pinned `hashicorp/google` **8.7.0** OpenTofu provider and isolated [bridge sessions](../../packages/bridge/README.md). This connector provisions infrastructure; it does not store credentials or supply the managed Cloud runtime's identity broker ([D1, #492](https://github.com/Sanoma-AI/sanoma/issues/492)).

The Google Cloud logo is the [official homepage asset](https://www.gstatic.com/cgc/google-cloud-logo-fullcolor.svg). Provider schema provenance and its verified download pin are recorded in `testdata/`; the provider binary is downloaded separately by the bridge.

## Resource types

| Constructor                    | Provider resource                            | Purpose                                                  |
| ------------------------------ | -------------------------------------------- | -------------------------------------------------------- |
| `gcp.keyRing`                  | `google_kms_key_ring`                        | KMS key ring in a project/location.                      |
| `gcp.cryptoKey`                | `google_kms_crypto_key`                      | Symmetric encryption key and rotation settings.          |
| `gcp.keyIamMember`             | `google_kms_crypto_key_iam_member`           | One member's role on one key.                            |
| `gcp.serviceAccount`           | `google_service_account`                     | Service account, without a private key.                  |
| `gcp.serviceAccountIamMember`  | `google_service_account_iam_member`          | One member's role on a service account.                  |
| `gcp.workloadIdentityPool`     | `google_iam_workload_identity_pool`          | Workload identity pool.                                  |
| `gcp.workloadIdentityProvider` | `google_iam_workload_identity_pool_provider` | OIDC issuer, claim mapping and explicit trust condition. |

The resource schemas are generated from the recorded provider schema; field names retain Google's provider spelling. Each type exposes read/import/plan and the apply workflow's create/update/delete operations. KMS key-ring/key deletion is refused, key replacement is refused during update, and key configuration uses `deletion_policy: "PREVENT"`. Retiring a key requires a separate retention procedure covering every encrypted value and recoverable backup. The driver refuses a desired purpose other than `ENCRYPT_DECRYPT` or an algorithm other than `GOOGLE_SYMMETRIC_ENCRYPTION`; signing and asymmetric keys are outside this connector’s scope.

## Deployment identity

`gcpWithIdentities` binds each named connection ID to trusted deployment configuration. Use the configured connector in `defineConfig`; the exported bare `gcp` has no live identity mapping.

```ts
// sanoma.config.ts: trusted deployment composition, never workflow input
import { defineConfig, defineConnection } from "sanoma";
import { gcpWithIdentities } from "@sanoma-ai/connector-gcp";

const gcp = gcpWithIdentities({
  "gcp/provisioning": {
    project: "example-company",
    projectNumber: "123456789012",
    serviceAccount: "provisioner@example-company.iam.gserviceaccount.com",
    credentialsFile: "/run/sanoma/gcp-wif.json",
  },
});
const provisioning = defineConnection(gcp, {
  name: "provisioning",
  method: "workloadIdentity",
  account: "provisioner@example-company.iam.gserviceaccount.com/example-company/123456789012",
});

export default defineConfig({ connectors: [gcp], connections: [provisioning] });
```

The mapping contains a file **path**, not its contents. Deliver the file through the trusted deployment environment; keep its contents and source tokens out of code, resource inputs, fixtures, logs and the secret-entry form. Treat this configuration and its file as security-sensitive even though no service-account private key is involved. Connect/verify the named account through the normal connection lifecycle; a declaration alone is not a verified binding.

Only an explicit `external_account` OIDC federation file is accepted. It must use Google's STS endpoint, a JWT subject token and impersonation of the exact configured service account. Service-account key files, executable sources, AWS environment sources and ambient ADC fallback are refused. A successful token exchange and impersonation verify the selected identity; a configured email alone is not proof. Verification returns the account identity and an empty scope list, not the access token or an attestation of individual IAM grants. Google IAM remains authoritative for permissions.

The provider receives that explicit federation configuration inside a fresh session for each authorized operation. The driver checks project IDs/numbers in resource identifiers and fields against the selected deployment. The provisioning account's Google IAM grants must also limit its authority: application-side checks do not replace IAM isolation. Give provisioning and company runtime different service accounts and roles; a company runtime must not inherit the provisioning account's IAM administration permissions.

### First administrator setup

An administrator must first establish the project, billing, required APIs, provisioning service account and initial federation trust using an existing authorized administration path. This connector has no project, billing or API-enablement resource. Grant the provisioning account only the KMS/IAM administration needed for its intended declarations, and grant the approved federated principal service-account impersonation access. Once that trust works, Sanoma can manage subsequent resources or import existing ones. See [Google's deployment-pipeline WIF setup](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines).

For GitHub Actions, bind trust to numeric `repository_owner_id` and `repository_id`, which survive name reuse safely. Map `google.subject` and any attributes used in principal bindings. Set an explicit provider condition; do not trust every repository under the shared GitHub issuer. Google describes these numeric claims in its [attribute-mapping guidance](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines#define_an_attribute_mapping).

Restrict branch, workflow and environment as well. For example, a policy for a production provisioning job can require all of these claims (replace every example with the intended deployment):

```text
assertion.repository_owner_id == '1234567' &&
assertion.repository_id == '7654321' &&
assertion.ref == 'refs/heads/main' &&
assertion.workflow_ref == 'example/company/.github/workflows/provision.yml@refs/heads/main' &&
assertion.environment == 'production'
```

The job must use that protected environment and request OIDC with `id-token: write`. Review the actual claims for the workflow; reusable workflows also expose `job_workflow_ref`. Protect changes to the trusted workflow and environment. See [GitHub's OIDC claims and permissions](https://docs.github.com/en/actions/reference/security/oidc). The connector requires a nonempty OIDC trust condition; it does not infer or enforce this particular GitHub policy for you.

The subject-token source must remain renewable for the full provisioning operation. A file holding one expiring JWT is not a long-lived identity service. Provide a source that refreshes its token or a supported refreshable URL source; both the Node verifier and provider process must be able to read it. Test renewal through expiry in the target environment. A GitHub job's identity belongs to that job, not to a subsequently hosted company runtime; runtime renewal remains D1's separate boundary.

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

## Testing and current evidence

`fakeGcp` is the bridge's in-memory resource fake; it is not Google IAM or a federation server. Authentication tests use synthetic STS/IAM responses and temporary token/config files, including separate account sources, denied impersonation, rejected key/executable configs and sanitized failures. Driver tests use a provider state double to check concurrent session separation, project/account refusals, symmetric-key and retention guards, OIDC condition requirements, sanitized failures and the fake. The recorded schema/pin in `testdata/` establishes the generated provider contract, not a successful cloud deployment.

Live provisioning verification is blocked: the verification project `sanoma-513217` reported billing disabled. There is no live provisioning, token-renewal or two-tenant IAM proof claimed here. Enabling billing and performing those checks require their own authorized cloud work.

Run `pnpm vitest run connectors/gcp` and the repository's type/lint/build checks. Regenerate types with `pnpm --filter @sanoma-ai/connector-gcp generate`; update the recorded schema/pins deliberately, and never edit `resources.gen.ts` by hand. Test-map details are in [test/AGENTS.md](test/AGENTS.md).
