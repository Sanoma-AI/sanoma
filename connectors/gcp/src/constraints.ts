import { DriverError } from "@sanoma-ai/workflows";
import type { ProviderClient } from "@sanoma-ai/bridge";

/** The same retention and trust rules apply to live and simulated resources. */
export function constrain(operation: string, input: { desired?: Record<string, unknown> }) {
  const [type, action] = operation.split(".");
  if ((type === "cryptoKey" || type === "keyRing") && action === "delete")
    throw new DriverError("gcp: retire KMS keys through the explicit retention procedure", { retryable: false });
  const desired = input.desired && { ...input.desired };
  if (desired && type === "cryptoKey") {
    const template = desired.version_template as { algorithm?: string } | undefined;
    if (
      (desired.purpose && desired.purpose !== "ENCRYPT_DECRYPT") ||
      (template?.algorithm && template.algorithm !== "GOOGLE_SYMMETRIC_ENCRYPTION")
    )
      throw new DriverError("gcp: only symmetric encryption keys are supported", { retryable: false });
    if (desired.deletion_policy && desired.deletion_policy !== "PREVENT")
      throw new DriverError("gcp: KMS deletion_policy must be PREVENT", { retryable: false });
    desired.deletion_policy = "PREVENT";
  }
  if (
    desired &&
    type === "workloadIdentityProvider" &&
    (!desired.oidc || desired.aws || desired.saml || !String(desired.attribute_condition ?? "").trim())
  )
    throw new DriverError("gcp: OIDC trust requires an issuer and an explicit attribute condition", {
      retryable: false,
    });
  return { ...input, ...(desired && { desired }) };
}

export function retainKeys(bridge: ProviderClient): ProviderClient {
  return {
    ...bridge,
    plan: async (...args) => {
      const result = await bridge.plan(...args);
      if (["google_kms_crypto_key", "google_kms_key_ring"].includes(args[1]) && result.action === "replace")
        throw new DriverError("gcp: KMS replacement requires explicit retirement", { retryable: false });
      return result;
    },
  };
}
