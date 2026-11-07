import type { ResourcesConfig } from "sanoma/internal/bridge/tfschema";

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
    "google_project_iam_custom_role",
    "google_project_iam_audit_config",
    "google_cloud_run_v2_service",
    "google_cloud_run_v2_service_iam_member",
  ],
  // ForceNew fields in Google's v8.7.0 resource definitions (google/services/kms, resourcemanager,
  // cloudrunv2 and tpgiamresource).
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
    google_project_iam_custom_role: ["project", "role_id"],
    google_project_iam_audit_config: ["project"],
    google_cloud_run_v2_service: ["location", "name", "project"],
    google_cloud_run_v2_service_iam_member: ["location", "member", "name", "project", "role"],
  },
} satisfies ResourcesConfig;
