import { Compute } from "google-auth-library";
import { enrollmentBroker } from "./identity-broker.ts";
import type { IdentityAudit, IdentityEnrollments } from "./cloud-identity.ts";

/** Fixed by the trusted provisioning issuer deployment, never by a request or company config. */
export interface ProvisioningIdentity {
  serviceAccount: string;
  /** Google's immutable numeric uniqueId for the source service account. */
  subject: string;
  /** Exact WIF provider audience whose trust condition pins this subject. */
  audience: string;
}
export interface ProvisioningIdToken {
  idToken: string;
  expiresAt: number;
}

const ACCOUNT = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;
const AUDIENCE =
  /^\/\/iam\.googleapis\.com\/projects\/[1-9][0-9]+\/locations\/global\/workloadIdentityPools\/[a-z][a-z0-9-]+\/providers\/[a-z][a-z0-9-]+$/;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const fail = () => new Error("Provisioning identity unavailable");

function identityOf(identity: ProvisioningIdentity): ProvisioningIdentity {
  if (
    !ACCOUNT.test(identity.serviceAccount) ||
    !/^[1-9][0-9]+$/.test(identity.subject) ||
    !AUDIENCE.test(identity.audience)
  )
    throw fail();
  return { serviceAccount: identity.serviceAccount, subject: identity.subject, audience: identity.audience };
}

// The issuer calls Google's authenticated HTTPS endpoint. Check its fixed claims and expiry;
// signature verification of the returned Google token remains Google's STS responsibility.
function tokenExpiry(idToken: string, identity: ProvisioningIdentity, now: number): number {
  try {
    if (typeof idToken !== "string" || idToken.length > 8192) throw fail();
    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw fail();
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (
      claims.iss !== "https://accounts.google.com" ||
      claims.sub !== identity.subject ||
      claims.aud !== identity.audience ||
      claims.email !== identity.serviceAccount ||
      claims.email_verified !== true ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat * 1000 > now + 30_000 ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 3600 ||
      claims.exp * 1000 <= now + 60_000 ||
      claims.exp * 1000 > now + 3_630_000
    )
      throw fail();
    return claims.exp * 1000;
  } catch {
    throw fail();
  }
}

/** Dedicated Cloud Run attached identity with getOpenIdToken on the fixed source account only. */
export function attachedGoogleIdTokenIssuer(configuration: ProvisioningIdentity): () => Promise<ProvisioningIdToken> {
  const identity = identityOf(configuration);
  const auth = new Compute({ scopes: [SCOPE] });
  return async () => {
    try {
      const response = await auth.request<{ token: string }>({
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${identity.serviceAccount}:generateIdToken`,
        method: "POST",
        data: { audience: identity.audience, includeEmail: true },
        timeout: 10_000,
      });
      const idToken = response.data.token;
      return { idToken, expiresAt: tokenExpiry(idToken, identity, Date.now()) };
    } catch {
      throw fail();
    }
  };
}

/**
 * GET /identity for a separate provisioning credential source. Deploy with its own enrollment
 * reader and attached issuer, outside the runtime broker. OIDC tokens last up to one hour:
 * revocation must remove federation/impersonation trust as well as stopping new issuance.
 */
export function provisioningIdentityBroker(options: {
  identity: ProvisioningIdentity;
  enrollments: IdentityEnrollments;
  /** Trusted Google issuer. The request cannot select subject, audience or token lifetime. */
  issue(): Promise<ProvisioningIdToken>;
  audit(event: IdentityAudit): Promise<void>;
}): (request: Request) => Promise<Response> {
  const identity = identityOf(options.identity);
  return enrollmentBroker({
    path: "/identity",
    method: "GET",
    enrollments: options.enrollments,
    accept: (enrollment) => enrollment.serviceAccount === identity.serviceAccount,
    issue: () => options.issue(),
    valid: (token, now) => token.expiresAt === tokenExpiry(token.idToken, identity, now),
    body: (token) => ({ idToken: token.idToken, expiresAt: token.expiresAt }),
    audit: options.audit,
  });
}
