import { createHash, randomBytes } from "node:crypto";
import { Compute, OAuth2Client } from "google-auth-library";
import type { Db } from "./db.ts";

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

/** Provisioning only. Deliver the value once through deployment secrets; persist only its hash. */
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

/** Install in the broker's own database using provisioning authority, never a company database. */
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
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz NOT NULL,
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
      const { rows } = await (
        await database()
      ).query<{
        deployment: string;
        company: string;
        environment: string;
        service_account: string;
        generation: string;
      }>(
        `SELECT d.id AS deployment, d.company, d.environment, d.service_account, c.generation
          FROM sanoma_identity.credentials c JOIN sanoma_identity.deployments d ON d.id = c.deployment
          WHERE c.hash = $1 AND NOT c.revoked AND d.enabled
            AND c.valid_from <= clock_timestamp() AND c.valid_until > clock_timestamp()`,
        [hash],
      );
      const row = rows[0];
      return (
        row && {
          deployment: row.deployment,
          company: row.company,
          environment: row.environment,
          serviceAccount: row.service_account,
          generation: Number(row.generation),
        }
      );
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
const validEnrollment = (e: IdentityEnrollment | undefined): e is IdentityEnrollment =>
  !!e &&
  [e.deployment, e.company, e.environment].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256) &&
  ACCOUNT.test(e.serviceAccount) &&
  Number.isSafeInteger(e.generation) &&
  e.generation > 0;
const validToken = (token: CloudAccessToken, now: number) =>
  typeof token?.accessToken === "string" &&
  token.accessToken.length > 0 &&
  token.accessToken.length <= 8192 &&
  !/[\s\r\n]/.test(token.accessToken) &&
  Number.isFinite(token.expiresAt) &&
  token.expiresAt > now &&
  token.expiresAt <= now + LIFETIME + 30_000;
const reply = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });

// Node/edge adapters can represent an empty POST as a stream. Reject actual bytes,
// without buffering attacker-controlled input or waiting indefinitely for its end.
async function hasBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new CloudIdentityError()), 5_000);
      }),
    ]);
    return !first.done;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
}

/** POST /token with a deployment bearer credential and no query or body. No enrollment endpoint. */
export function identityBroker(options: IdentityBrokerOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    let enrollment: IdentityEnrollment | undefined;
    try {
      const url = new URL(request.url);
      if (url.pathname !== "/token" || request.method !== "POST") return reply(404, { error: "not_found" });
      if (url.search || (await hasBody(request))) return reply(400, { error: "invalid_request" });
      const authorization = request.headers.get("authorization") ?? "";
      const credential = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const hash = CREDENTIAL.test(credential) ? credentialHash(credential) : undefined;
      enrollment = hash ? await options.enrollments.active(hash) : undefined;
      if (!validEnrollment(enrollment)) {
        await options.audit({ result: "denied" });
        return reply(401, { error: "unauthorized" });
      }
      // Copy authoritative values before any awaits; caller fields never select a target or lifetime.
      enrollment = {
        deployment: enrollment.deployment,
        company: enrollment.company,
        environment: enrollment.environment,
        serviceAccount: enrollment.serviceAccount,
        generation: enrollment.generation,
      };
      const token = await options.issue(enrollment.serviceAccount);
      if (!validToken(token, Date.now())) throw new CloudIdentityError();
      const current = await options.enrollments.active(hash!);
      if (
        !current ||
        (Object.keys(enrollment) as (keyof IdentityEnrollment)[]).some((key) => current[key] !== enrollment![key])
      ) {
        await options.audit({ result: "denied", enrollment });
        return reply(401, { error: "unauthorized" });
      }
      await options.audit({ result: "issued", enrollment, expiresAt: token.expiresAt });
      return reply(200, { accessToken: token.accessToken, expiresAt: token.expiresAt });
    } catch {
      try {
        await options.audit({ result: "unavailable", ...(enrollment && { enrollment }) });
      } catch {
        /* fail closed */
      }
      return reply(503, { error: "unavailable" });
    }
  };
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
