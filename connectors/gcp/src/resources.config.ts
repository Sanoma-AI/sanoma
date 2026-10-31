import type { ResourcesConfig } from "@sanoma-ai/bridge/tfschema";

export default {
  provider: "hashicorp/google",
  types: [
    "google_kms_key_ring",
    "google_kms_crypto_key",
    "google_kms_crypto_key_iam_member",
    "google_service_account",
    "google_service_account_iam_member",
    "google_iam_workload_identity_pool",
    "google_iam_workload_identity_pool_provider",
  ],
  // ForceNew fields in Google's v8.7.0 google/services/kms resource definitions.
  immutable: {
    google_kms_key_ring: ["location", "name", "project"],
    google_kms_crypto_key: [
      "key_ring",
      "name",
      "crypto_key_backend",
      "destroy_scheduled_duration",
      "import_only",
      "purpose",
      "version_template.protection_level",
    ],
  },
} satisfies ResourcesConfig;
