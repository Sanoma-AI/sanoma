import { AuthenticationError } from "@sanoma-ai/workflows";
import type { GcpIdentity } from "./authentication.ts";

/** Build a protected URL-source WIF configuration for the separate provisioning identity service. */
export function gcpProvisioningIdentity(options: {
  project: string;
  projectNumber: string;
  serviceAccount: string;
  audience: string;
  /** HTTPS GET /identity endpoint; fixed by the deployment, never connection input. */
  issuer: string;
  /** Read the current provisioning bearer from protected host configuration. */
  credential(): Promise<string>;
}): GcpIdentity {
  const { project, projectNumber, serviceAccount, audience, issuer, credential } = options;
  try {
    const url = new URL(issuer);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/identity" ||
      !/^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]+\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]+\/providers\/[a-z][a-z0-9-]+$/.test(
        audience,
      )
    )
      throw new Error();
  } catch {
    throw new AuthenticationError("rejected");
  }
  return {
    project,
    projectNumber,
    serviceAccount,
    credentials: async () => {
      try {
        const bearer = await credential();
        if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) throw new Error();
        return JSON.stringify({
          type: "external_account",
          audience,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: "https://sts.googleapis.com/v1/token",
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
          service_account_impersonation: { token_lifetime_seconds: 600 },
          credential_source: {
            url: issuer,
            headers: { Authorization: `Bearer ${bearer}` },
            format: { type: "json", subject_token_field_name: "idToken" },
          },
        });
      } catch {
        throw new AuthenticationError("rejected");
      }
    },
  };
}
