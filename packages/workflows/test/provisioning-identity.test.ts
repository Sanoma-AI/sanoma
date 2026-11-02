import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  provisioningIdentityBroker,
  attachedGoogleIdTokenIssuer,
  createDeploymentCredential,
  type IdentityEnrollment,
  type IdentityAudit,
  type ProvisioningIdentity,
  type ProvisioningIdToken,
} from "../src/cloud-identity.ts";

const identity: ProvisioningIdentity = {
  serviceAccount: "provision-source@identity-project.iam.gserviceaccount.com",
  subject: "123456789012345678901",
  audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/provision/providers/google",
};
const endpoint = "https://provision-identity.example.test/identity";
const claimsOf = () => ({
  iss: "https://accounts.google.com",
  sub: identity.subject,
  aud: identity.audience,
  email: identity.serviceAccount,
  email_verified: true,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const jwt = (claims: object = claimsOf()) =>
  [{ alg: "RS256", typ: "JWT" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".syntheticSignature";
const token = (claims = claimsOf()) => ({ idToken: jwt(claims), expiresAt: claims.exp * 1000 });
function fixture() {
  const credential = createDeploymentCredential();
  const enrollment: IdentityEnrollment = {
    deployment: "control-plane-production",
    company: "sanoma",
    environment: "production",
    serviceAccount: identity.serviceAccount,
    generation: 1,
  };
  const rows = new Map([[credential.hash, enrollment]]);
  const events: IdentityAudit[] = [];
  const issue = vi.fn<() => Promise<ProvisioningIdToken>>(async () => token());
  const audit = vi.fn<(event: IdentityAudit) => Promise<void>>(async (event) => {
    events.push(event);
  });
  const broker = provisioningIdentityBroker({
    identity,
    enrollments: { active: async (hash) => rows.get(hash) },
    issue,
    audit,
  });
  const request = (url = endpoint, bearer = credential.credential, method = "GET") =>
    new Request(url, { method, headers: { Authorization: `Bearer ${bearer}` } });
  return { credential, enrollment, rows, events, issue, audit, broker, request };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("dedicated provisioning identity source", () => {
  it("fixes source identity and audience and returns only the WIF token fields", async () => {
    const f = fixture();
    const issued = token();
    f.issue.mockResolvedValue(issued);
    const response = await f.broker(f.request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(issued);
    expect(f.events).toEqual([{ result: "issued", enrollment: f.enrollment, expiresAt: issued.expiresAt }]);
    expect(JSON.stringify(f.events)).not.toContain(f.credential.credential);
    expect(JSON.stringify(f.events)).not.toContain("syntheticSignature");
    expect(f.issue).toHaveBeenCalledWith();
  });

  it("refuses runtime credentials, wrong targets, overrides and enrollment endpoints", async () => {
    const f = fixture();
    for (const request of [
      f.request(endpoint, createDeploymentCredential().credential),
      f.request(endpoint + "?audience=other"),
      f.request(endpoint, f.credential.credential, "POST"),
      f.request("https://provision-identity.example.test/token"),
      f.request("https://provision-identity.example.test/enroll"),
    ])
      expect((await f.broker(request)).status).toBeGreaterThanOrEqual(400);
    f.rows.set(f.credential.hash, {
      ...f.enrollment,
      serviceAccount: "runtime-a@identity-project.iam.gserviceaccount.com",
    });
    expect((await f.broker(f.request())).status).toBe(401);
    expect(f.issue).not.toHaveBeenCalled();
  });

  it("rechecks enrollment after issuance and stops new issuance after revocation", async () => {
    const f = fixture();
    f.issue.mockImplementationOnce(async () => {
      f.rows.delete(f.credential.hash);
      return token();
    });
    expect((await f.broker(f.request())).status).toBe(401);
    expect((await f.broker(f.request())).status).toBe(401);
    expect(f.issue).toHaveBeenCalledTimes(1);
    expect(f.events.map((event) => event.result)).toEqual(["denied", "denied"]);
  });

  it("fails closed on audit or issuer failure without forwarding diagnostics", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error("synthetic-sensitive-provider-diagnostic"));
    let response = await f.broker(f.request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
    f.audit.mockRejectedValue(new Error("synthetic-database-password"));
    response = await f.broker(f.request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic");
  });

  it("refuses mismatched claims, false expiry, expired and overlong tokens", async () => {
    const f = fixture();
    for (const override of [
      { sub: "987654321" },
      { aud: "other" },
      { email: "other@example.test" },
      { iss: "https://untrusted.example.test" },
      { email_verified: false },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { exp: Math.floor(Date.now() / 1000) + 7200 },
      { iat: Math.floor(Date.now() / 1000) + 120 },
    ]) {
      f.issue.mockResolvedValueOnce(token({ ...claimsOf(), ...override }));
      expect((await f.broker(f.request())).status).toBe(503);
    }
    f.issue.mockResolvedValueOnce({ ...token(), expiresAt: Date.now() + 600_000 });
    expect((await f.broker(f.request())).status).toBe(503);
    expect(f.events.every((event) => event.result === "unavailable")).toBe(true);
  });

  it("is a URL credential source consumed by the official Google auth library", async () => {
    const f = fixture();
    let exchanges = 0;
    const target = "provisioner@identity-project.iam.gserviceaccount.com";
    const impersonation = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${target}:generateAccessToken`;
    const server = setupServer(
      http.get(endpoint, ({ request }) => f.broker(request)),
      http.post("https://sts.googleapis.com/v1/token", async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        expect(form.get("subject_token")).toContain("syntheticSignature");
        expect(form.get("audience")).toBe(identity.audience);
        exchanges++;
        return HttpResponse.json({ access_token: "synthetic-federated", expires_in: 3600, token_type: "Bearer" });
      }),
      http.post(impersonation, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-federated");
        expect(await request.json()).toMatchObject({ lifetime: "600s" });
        return HttpResponse.json({
          accessToken: "synthetic-provision-token",
          expireTime: new Date(Date.now() + 600_000).toISOString(),
        });
      }),
    );
    server.listen({ onUnhandledFrame: "error" });
    try {
      const auth = new GoogleAuth({
        credentials: {
          type: "external_account",
          audience: identity.audience,
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: "https://sts.googleapis.com/v1/token",
          service_account_impersonation_url: impersonation,
          service_account_impersonation: { token_lifetime_seconds: 600 },
          credential_source: {
            url: endpoint,
            headers: { Authorization: `Bearer ${f.credential.credential}` },
            format: { type: "json", subject_token_field_name: "idToken" },
          },
        },
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      expect(await auth.getAccessToken()).toBe("synthetic-provision-token");
      expect(exchanges).toBe(1);
      expect(f.issue).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });

  it("mints through attached identity with a fixed Google IAM request and no ADC file", async () => {
    const requests: unknown[] = [];
    const expected = token();
    const server = setupServer(
      http.get("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", ({ request }) => {
        expect(request.headers.get("metadata-flavor")).toBe("Google");
        return HttpResponse.json(
          { access_token: "synthetic-attached", expires_in: 3600, token_type: "Bearer" },
          { headers: { "Metadata-Flavor": "Google" } },
        );
      }),
      http.post(
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/:target",
        async ({ request, params }) => {
          requests.push({
            target: params.target,
            body: await request.json(),
            authorization: request.headers.get("authorization"),
          });
          return HttpResponse.json({ token: expected.idToken });
        },
      ),
    );
    server.listen({ onUnhandledFrame: "error" });
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/must-not-read.json");
    try {
      expect(await attachedGoogleIdTokenIssuer(identity)()).toEqual(expected);
      expect(requests).toEqual([
        {
          target: `${identity.serviceAccount}:generateIdToken`,
          body: { audience: identity.audience, includeEmail: true },
          authorization: "Bearer synthetic-attached",
        },
      ]);
    } finally {
      server.close();
    }
  });
});
