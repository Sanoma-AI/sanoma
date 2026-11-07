import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import { AuthenticationError, defineAuthentication, type StoredAuthentication } from "sanoma/workflows";

/**
 * The provisioning identity, declared in code: who the connection provisions as and where its
 * Google OIDC tokens come from. None of it is secret; the bearer that unlocks the issuer is the
 * connection's stored credential, entered on the connector page.
 */
export interface GcpIdentity {
  /** The project the provisioning account works in, by ID. */
  project: string;
  /** The same project's number: resource names Google returns use either. */
  projectNumber: string;
  /** The provisioning service account the federated principal impersonates. */
  serviceAccount: string;
  /** The workload identity provider's full audience. */
  audience: string;
  /** The provisioning identity service's HTTPS `GET /identity` endpoint. */
  issuer: string;
}

/** What the connection stores: the provisioning bearer, never the identity facts. */
const bundle = z.object({
  bearer: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "A provisioning bearer is 43 base64url characters")
    .describe(
      "The provisioning bearer the identity service enrolled for this control plane: 43 base64url characters, from the enrollment that minted it",
    ),
});

const AUDIENCE =
  /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]+\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]+\/providers\/[a-z][a-z0-9-]+$/;

/** Refuses facts that could not name one provisioning account and one HTTPS issuer. */
export function checkIdentity(identity: GcpIdentity): GcpIdentity {
  const { project, projectNumber, serviceAccount, audience, issuer } = identity;
  try {
    const url = new URL(issuer);
    if (
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) ||
      !/^[1-9][0-9]+$/.test(projectNumber) ||
      !/^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount) ||
      !AUDIENCE.test(audience) ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/identity"
    )
      throw new Error();
  } catch {
    throw new AuthenticationError("rejected");
  }
  return Object.freeze({ project, projectNumber, serviceAccount, audience, issuer });
}

/**
 * The external-account configuration for one invocation: Google's STS, the configured
 * impersonation target and the issuer as a URL source carrying the bearer. Built in memory from
 * declared facts; no ambient ADC, key file or executable source can be expressed.
 */
export function federationCredentials(identity: GcpIdentity, bearer: string) {
  return {
    type: "external_account",
    audience: identity.audience,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${identity.serviceAccount}:generateAccessToken`,
    service_account_impersonation: { token_lifetime_seconds: 600 },
    credential_source: {
      url: identity.issuer,
      headers: { Authorization: `Bearer ${bearer}` },
      format: { type: "json", subject_token_field_name: "idToken" },
    },
  };
}

export const accountOf = (identity: GcpIdentity) =>
  `${identity.serviceAccount}/${identity.project}/${identity.projectNumber}`;

/** The `workloadIdentity` method: a stored bearer, verified by federating once as the identity. */
export function gcpAuthentication(identity?: GcpIdentity): StoredAuthentication<typeof bundle> {
  return defineAuthentication({
    kind: "api-key",
    version: 1,
    schema: bundle,
    storage: { writable: false, conditionalWrites: false, maxBytes: 1024 },
    async verify({ bearer }) {
      if (!identity) throw new AuthenticationError("missing");
      try {
        // One OIDC token from the issuer, exchanged at STS and used to impersonate the configured
        // account: success proves the bearer is enrolled and trusted for exactly that account.
        const auth = new GoogleAuth({
          credentials: federationCredentials(identity, bearer),
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        if (!(await auth.getAccessToken())) throw new Error();
      } catch {
        throw new AuthenticationError("unavailable");
      }
      return { account: accountOf(identity), scopes: [] };
    },
  });
}
