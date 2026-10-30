import { tfConnector } from "@sanoma-ai/bridge/connector";
import { vendorInfo } from "@sanoma-ai/workflows";
import {
  provider,
  google_kms_key_ring,
  google_kms_crypto_key,
  google_kms_crypto_key_iam_member,
  google_service_account,
  google_service_account_iam_member,
  google_iam_workload_identity_pool,
  google_iam_workload_identity_pool_provider,
} from "./resources.gen.ts";

export const gcpTf = tfConnector({
  vendor: "gcp",
  provider,
  info: vendorInfo(import.meta.url),
  types: {
    keyRing: { tf: google_kms_key_ring, title: "KMS key ring", writable: true },
    cryptoKey: { tf: google_kms_crypto_key, title: "KMS key", writable: true },
    keyIamMember: { tf: google_kms_crypto_key_iam_member, title: "KMS key access", writable: true },
    serviceAccount: { tf: google_service_account, title: "Service account", writable: true },
    serviceAccountIamMember: { tf: google_service_account_iam_member, title: "Service account access", writable: true },
    workloadIdentityPool: { tf: google_iam_workload_identity_pool, title: "Workload identity pool", writable: true },
    workloadIdentityProvider: { tf: google_iam_workload_identity_pool_provider, title: "OIDC trust", writable: true },
  },
  references: {
    cryptoKey: { key_ring: { type: "gcp.keyRing" } },
    keyIamMember: { crypto_key_id: { type: "gcp.cryptoKey" } },
    serviceAccountIamMember: { service_account_id: { type: "gcp.serviceAccount" } },
  },
});
