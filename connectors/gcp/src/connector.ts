import { tfConnector } from "sanoma/internal/bridge/connector";
import { vendorInfo } from "sanoma/workflows";
import {
  provider,
  google_cloud_run_v2_service,
  google_cloud_run_v2_service_iam_member,
  google_kms_key_ring,
  google_kms_crypto_key,
  google_kms_crypto_key_iam_member,
  google_project_iam_audit_config,
  google_project_iam_custom_role,
  google_service_account,
  google_service_account_iam_member,
  google_iam_workload_identity_pool,
  google_iam_workload_identity_pool_provider,
} from "./resources.gen.ts";

// Google's IAM state IDs contain slash-separated role/member/condition fields, but
// its importer takes space-separated fields. Derive a round-trippable binding ID
// from structured state rather than parsing slashes inside custom roles/principals.
// The same fields of a declaration are its import ID before it is bound (`find`).
const iamBindingId = (parent: string) => (state: Record<string, unknown>) => {
  const condition = state.condition as { title?: string } | null | undefined;
  if (!state[parent] || !state.role || !state.member) return "";
  return [state[parent], state.role, state.member, ...(condition?.title ? [condition.title] : [])].join(" ");
};
const keyMemberId = iamBindingId("crypto_key_id");
const serviceAccountMemberId = iamBindingId("service_account_id");
const cloudRunMemberId = iamBindingId("name");

// The provider's audit config state ID is `<project>/audit_config/<service>`; its importer takes this.
const auditConfigId = ({ project, service }: Record<string, unknown>) =>
  project && service ? `${project} ${service}` : "";

/** `projects/<project>/<path>` when every part is declared; empty (no identity) otherwise. */
const projectPath = (project: unknown, ...path: unknown[]) =>
  project && path.every(Boolean) ? `projects/${project}/${path.join("/")}` : "";

/** Fields that name a parent resource by its full name; the driver holds each to the project. */
export const references = {
  cryptoKey: { key_ring: { type: "gcp.keyRing" } },
  keyIamMember: { crypto_key_id: { type: "gcp.cryptoKey" } },
  serviceAccountIamMember: { service_account_id: { type: "gcp.serviceAccount" } },
  cloudRunServiceIamMember: { name: { type: "gcp.cloudRunService" } },
} as const;

export const gcpTf = tfConnector({
  vendor: "gcp",
  provider,
  info: vendorInfo(import.meta.url),
  // Each identity is the provider's import ID, which is also its state `id` (IAM types aside),
  // so a first apply finds an existing object and binds it instead of creating it again.
  types: {
    keyRing: {
      tf: google_kms_key_ring,
      title: "KMS key ring",
      identity: "projects/project/locations/location/keyRings/name",
      find: ({ project, location, name }) => projectPath(project, "locations", location, "keyRings", name),
      writable: true,
    },
    cryptoKey: {
      tf: google_kms_crypto_key,
      title: "KMS key",
      identity: "key_ring/cryptoKeys/name",
      find: ({ key_ring, name }) => (key_ring && name ? `${key_ring}/cryptoKeys/${name}` : ""),
      writable: true,
    },
    keyIamMember: {
      tf: google_kms_crypto_key_iam_member,
      title: "KMS key access",
      identity: "crypto_key_id role member [condition title]",
      find: keyMemberId,
      writable: true,
      bindingId: keyMemberId,
    },
    serviceAccount: {
      tf: google_service_account,
      title: "Service account",
      identity: "projects/project/serviceAccounts/account_id@project.iam.gserviceaccount.com",
      find: ({ project, account_id }) =>
        projectPath(project, "serviceAccounts", account_id && `${account_id}@${project}.iam.gserviceaccount.com`),
      writable: true,
    },
    serviceAccountIamMember: {
      tf: google_service_account_iam_member,
      title: "Service account access",
      identity: "service_account_id role member [condition title]",
      find: serviceAccountMemberId,
      writable: true,
      bindingId: serviceAccountMemberId,
    },
    workloadIdentityPool: {
      tf: google_iam_workload_identity_pool,
      title: "Workload identity pool",
      identity: "projects/project/locations/global/workloadIdentityPools/workload_identity_pool_id",
      find: ({ project, workload_identity_pool_id: pool }) =>
        projectPath(project, "locations/global/workloadIdentityPools", pool),
      writable: true,
    },
    workloadIdentityProvider: {
      tf: google_iam_workload_identity_pool_provider,
      title: "OIDC trust",
      identity: "projects/project/locations/global/workloadIdentityPools/pool/providers/provider",
      find: ({ project, workload_identity_pool_id: pool, workload_identity_pool_provider_id: id }) =>
        projectPath(project, "locations/global/workloadIdentityPools", pool, "providers", id),
      writable: true,
    },
    customRole: {
      tf: google_project_iam_custom_role,
      title: "Custom role",
      identity: "projects/project/roles/role_id",
      find: ({ project, role_id }) => projectPath(project, "roles", role_id),
      writable: true,
    },
    auditConfig: {
      tf: google_project_iam_audit_config,
      title: "Audit logging",
      identity: "project service",
      find: auditConfigId,
      bindingId: auditConfigId,
      writable: true,
    },
    cloudRunService: {
      tf: google_cloud_run_v2_service,
      title: "Cloud Run service",
      identity: "projects/project/locations/location/services/name",
      find: ({ project, location, name }) => projectPath(project, "locations", location, "services", name),
      writable: true,
    },
    cloudRunServiceIamMember: {
      tf: google_cloud_run_v2_service_iam_member,
      title: "Cloud Run service access",
      identity: "name role member [condition title]",
      find: cloudRunMemberId,
      writable: true,
      bindingId: cloudRunMemberId,
    },
  },
  references,
});
