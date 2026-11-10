import { createHash, randomBytes } from "node:crypto";
import { Compute, OAuth2Client } from "google-auth-library";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import { identityCredentials, identityDeployments } from "./db/identity.ts";
import { enrollmentBroker } from "./identity-broker.ts";
export { provisioningIdentityBroker, attachedGoogleIdTokenIssuer } from "./provisioning-identity.ts";
export type { ProvisioningIdentity, ProvisioningIdToken } from "./provisioning-identity.ts";

export { postgresIdentityProvisioning, IdentityProvisioningError } from "./identity-provisioning.ts";
export type { IdentityProvisioning, DeploymentIdentity, EnrollIdentity } from "./identity-provisioning.ts";

const LIFETIME = 600_000;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const ACCOUNT = /^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/** A safe error boundary: no HTTP response, credentials, SDK cause or request options. */
export class CloudIdentityError extends Error {
  constructor() {
    super("Cloud identity unavailable");
    this.name = "CloudIdentityError";
  }
}

/** Provisioning only. Deliver through deployment secrets; persist only its hash in the enrollment database. */
export function createDeploymentCredential(): { credential: string; hash: string } {
  const credential = randomBytes(32).toString("base64url");
  return { credential, hash: credentialHash(credential) };
}
const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");

export interface IdentityEnrollment {
  deployment: string;
  company: string;
  environment: string;
  serviceAccount: string;
  generation: number;
}
export interface IdentityEnrollments {
  /** Return an enrollment only while this hash/generation and deployment are active. Never cache. */
  active(hash: string): Promise<IdentityEnrollment | undefined>;
}

/**
 * Install in the broker's own database using provisioning authority, never a company database. A
 * credential without `valid_until` has no expiry: it holds until it is retired or revoked.
 */
export const CLOUD_IDENTITY_SQL = `
CREATE SCHEMA IF NOT EXISTS sanoma_identity;
REVOKE ALL ON SCHEMA sanoma_identity FROM PUBLIC;
CREATE TABLE IF NOT EXISTS sanoma_identity.deployments (
  id text PRIMARY KEY, company text NOT NULL, environment text NOT NULL,
  service_account text NOT NULL, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sanoma_identity.credentials (
  hash text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
  deployment text NOT NULL REFERENCES sanoma_identity.deployments(id),
  generation bigint NOT NULL CHECK (generation > 0),
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz,
  revoked boolean NOT NULL DEFAULT false,
  UNIQUE (deployment, generation), CHECK (valid_until > valid_from),
  CHECK (isfinite(valid_from) AND isfinite(valid_until))
);
REVOKE ALL ON ALL TABLES IN SCHEMA sanoma_identity FROM PUBLIC;
`;

/** Give the broker SELECT only; enrollment, rotation and revocation use a separate database role. */
export function postgresIdentityEnrollments(database: () => Promise<Db>): IdentityEnrollments {
  return {
    async active(hash) {
      const [row] = await (
        await database()
      )
        .select({
          deployment: identityDeployments.id,
          company: identityDeployments.company,
          environment: identityDeployments.environment,
          serviceAccount: identityDeployments.serviceAccount,
          generation: identityCredentials.generation,
        })
        .from(identityCredentials)
        .innerJoin(identityDeployments, eq(identityDeployments.id, identityCredentials.deployment))
        .where(
          and(
            eq(identityCredentials.hash, hash),
            eq(identityCredentials.revoked, false),
            eq(identityDeployments.enabled, true),
            lte(identityCredentials.validFrom, sql`clock_timestamp()`),
            or(isNull(identityCredentials.validUntil), gt(identityCredentials.validUntil, sql`clock_timestamp()`)),
          ),
        );
      return row;
    },
  };
}

export interface CloudAccessToken {
  accessToken: string;
  expiresAt: number;
}
export interface IdentityAudit {
  result: "issued" | "denied" | "unavailable";
  enrollment?: IdentityEnrollment;
  expiresAt?: number;
}
export interface IdentityBrokerOptions {
  enrollments: IdentityEnrollments;
  /** Trusted issuer with attached platform authority; target comes exclusively from enrollment. */
  issue(serviceAccount: string): Promise<CloudAccessToken>;
  /** Must durably record the decision without token values. A failure prevents delivery. */
  audit(event: IdentityAudit): Promise<void>;
}
const validToken = (token: CloudAccessToken, now: number) =>
  typeof token?.accessToken === "string" &&
  token.accessToken.length > 0 &&
  token.accessToken.length <= 8192 &&
  !/[\s\r\n]/.test(token.accessToken) &&
  Number.isFinite(token.expiresAt) &&
  token.expiresAt > now &&
  token.expiresAt <= now + LIFETIME + 30_000;
/** POST /token with a deployment bearer credential and no query or body. No enrollment endpoint. */
export function identityBroker(options: IdentityBrokerOptions): (request: Request) => Promise<Response> {
  return enrollmentBroker({
    ...options,
    path: "/token",
    method: "POST",
    accept: () => true,
    issue: (enrollment) => options.issue(enrollment.serviceAccount),
    valid: validToken,
    body: (token) => ({ accessToken: token.accessToken, expiresAt: token.expiresAt }),
  });
}

/** Cloud Run attached identity only: no ADC environment file or service-account private key fallback. */
export function attachedGoogleTokenIssuer(): IdentityBrokerOptions["issue"] {
  const auth = new Compute({ scopes: [SCOPE] });
  return async (serviceAccount) => {
    if (!ACCOUNT.test(serviceAccount)) throw new CloudIdentityError();
    try {
      const response = await auth.request<{ accessToken: string; expireTime: string }>({
        url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
        method: "POST",
        data: { scope: [SCOPE], lifetime: "600s" },
        timeout: 10_000,
      });
      const token = { accessToken: response.data.accessToken, expiresAt: Date.parse(response.data.expireTime) };
      if (!validToken(token, Date.now())) throw new CloudIdentityError();
      return token;
    } catch {
      throw new CloudIdentityError();
    }
  };
}

/** A per-runtime Google SDK auth client. Short-lived access tokens are kept only in this instance's memory. */
export function cloudIdentityAuth(options: {
  endpoint: string;
  /** Read the current deployment credential from protected bootstrap; called again on renewal. */
  credential(): Promise<string>;
}): OAuth2Client {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new CloudIdentityError();
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/token"
  )
    throw new CloudIdentityError();
  const client = new OAuth2Client({ eagerRefreshThresholdMillis: 60_000 });
  let pending: Promise<{ access_token: string; expiry_date: number }> | undefined;
  client.refreshHandler = () => {
    if (pending) return pending;
    pending = (async () => {
      try {
        const credential = await options.credential();
        if (!CREDENTIAL.test(credential)) throw new CloudIdentityError();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential}` },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new CloudIdentityError();
        const raw = await response.text();
        if (raw.length > 16_384) throw new CloudIdentityError();
        const token = JSON.parse(raw) as CloudAccessToken;
        const now = Date.now();
        if (!validToken(token, now) || token.expiresAt <= now + 60_000) throw new CloudIdentityError();
        return { access_token: token.accessToken, expiry_date: token.expiresAt };
      } catch {
        throw new CloudIdentityError();
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
  return client;
}
