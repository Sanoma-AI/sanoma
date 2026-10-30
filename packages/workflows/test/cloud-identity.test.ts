import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  cloudIdentityAuth,
  createDeploymentCredential,
  identityBroker,
  attachedGoogleTokenIssuer,
  type IdentityEnrollment,
  type IdentityAudit,
} from "../src/cloud-identity.ts";

const endpoint = "https://issuer.example.test/token";
const enrollment = (company: string, environment = "production"): IdentityEnrollment => ({
  deployment: `${company}-${environment}`,
  company,
  environment,
  generation: 1,
  serviceAccount: `${company}-${environment}@identity-project.iam.gserviceaccount.com`,
});
function fixture() {
  const a = createDeploymentCredential(),
    b = createDeploymentCredential(),
    preview = createDeploymentCredential();
  const rows = new Map([
    [a.hash, enrollment("company-a")],
    [b.hash, enrollment("company-b")],
    [preview.hash, enrollment("company-a", "preview")],
  ]);
  const events: IdentityAudit[] = [];
  const issue = vi.fn<(target: string) => Promise<{ accessToken: string; expiresAt: number }>>(async (target) => ({
    accessToken: `synthetic:${target}`,
    expiresAt: Date.now() + 600_000,
  }));
  const broker = identityBroker({
    enrollments: { active: async (hash) => rows.get(hash) },
    issue,
    audit: async (event) => {
      events.push(event);
    },
  });
  const request = (credential = a.credential, init: RequestInit = {}) =>
    new Request(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
      ...init,
    });
  return { a, b, preview, rows, events, issue, broker, request };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("trusted identity issuer", () => {
  it("uses attached metadata identity and fixes IAM scope and lifetime without credential-file fallback", async () => {
    const requests: unknown[] = [];
    const server = setupServer(
      http.get("http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token", ({ request }) => {
        expect(request.headers.get("metadata-flavor")).toBe("Google");
        return HttpResponse.json(
          { access_token: "synthetic-attached-token", expires_in: 3600, token_type: "Bearer" },
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
          return HttpResponse.json({
            accessToken: "synthetic-issued-token",
            expireTime: new Date(Date.now() + 600_000).toISOString(),
          });
        },
      ),
    );
    server.listen({ onUnhandledFrame: "error" });
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/must-not-read-a-private-key.json");
    try {
      const token = await attachedGoogleTokenIssuer()(enrollment("company-a").serviceAccount);
      expect(token.accessToken).toBe("synthetic-issued-token");
      expect(requests).toEqual([
        {
          target: `${enrollment("company-a").serviceAccount}:generateAccessToken`,
          body: { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "600s" },
          authorization: "Bearer synthetic-attached-token",
        },
      ]);
    } finally {
      server.close();
      vi.unstubAllEnvs();
    }
  });
  it("issues only the mapped company/environment identity and records no credential or token", async () => {
    const f = fixture();
    for (const [credential, expected] of [
      [f.a, enrollment("company-a")],
      [f.b, enrollment("company-b")],
      [f.preview, enrollment("company-a", "preview")],
    ] as const) {
      const response = await f.broker(f.request(credential.credential));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        accessToken: `synthetic:${expected.serviceAccount}`,
        expiresAt: expect.any(Number),
      });
      expect(f.issue).toHaveBeenLastCalledWith(expected.serviceAccount);
      expect(f.events.at(-1)).toMatchObject({ result: "issued", enrollment: expected });
      expect(JSON.stringify(f.events)).not.toContain(credential.credential);
      expect(JSON.stringify(f.events)).not.toContain("synthetic:");
    }
  });
  it("rejects target overrides, unknown/revoked credentials and enrollment requests", async () => {
    const f = fixture();
    expect(
      (
        await f.broker(
          f.request(f.a.credential, {
            body: JSON.stringify({ serviceAccount: enrollment("company-b").serviceAccount }),
          }),
        )
      ).status,
    ).toBe(400);
    expect((await f.broker(new Request(`${endpoint}?company=company-b`, { method: "POST" }))).status).toBe(400);
    expect((await f.broker(new Request("https://issuer.example.test/enroll", { method: "POST" }))).status).toBe(404);
    expect((await f.broker(f.request(createDeploymentCredential().credential))).status).toBe(401);
    f.rows.delete(f.a.hash);
    expect((await f.broker(f.request())).status).toBe(401);
    expect(f.issue).not.toHaveBeenCalled();
  });
  it("rechecks authority after minting and refuses a revoked or remapped generation", async () => {
    const f = fixture();
    f.issue.mockImplementationOnce(async (target) => {
      f.rows.set(f.a.hash, { ...enrollment("company-b"), generation: 2 });
      return { accessToken: `synthetic:${target}`, expiresAt: Date.now() + 600_000 };
    });
    const response = await f.broker(f.request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("synthetic:");
  });
  it("sanitizes issuer failures and never delivers a token when audit persistence fails", async () => {
    const f = fixture();
    f.issue.mockRejectedValueOnce(new Error("synthetic-sensitive-provider-diagnostic"));
    const response = await f.broker(f.request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
    expect(JSON.stringify(f.events)).not.toContain("synthetic-sensitive");
    const brokenAudit = identityBroker({
      enrollments: { active: async () => enrollment("company-a") },
      issue: f.issue,
      audit: async () => {
        throw new Error("audit unavailable");
      },
    });
    expect((await brokenAudit(f.request())).status).toBe(503);
  });
  it("refuses expired and excessive-lifetime tokens from an issuer", async () => {
    const f = fixture();
    for (const expiresAt of [Date.now() - 1, Date.now() + 3_600_000, NaN]) {
      f.issue.mockResolvedValueOnce({ accessToken: "synthetic", expiresAt });
      expect((await f.broker(f.request())).status).toBe(503);
    }
  });
});

describe("runtime Google SDK auth", () => {
  it("accepts an empty POST stream through HTTP transport and refuses actual body bytes", async () => {
    const f = fixture();
    const server = setupServer(http.post(endpoint, ({ request }) => f.broker(request)));
    server.listen({ onUnhandledFrame: "error" });
    try {
      const auth = cloudIdentityAuth({ endpoint, credential: async () => f.a.credential });
      expect((await auth.getAccessToken()).token).toContain("company-a-production");
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.a.credential}` },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(f.issue).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
  it("coalesces cold-start requests, renews before expiry with rotated bootstrap and separates instances", async () => {
    const f = fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, init) => f.broker(new Request(url, init))),
    );
    let credential = f.a.credential;
    const auth = cloudIdentityAuth({ endpoint, credential: async () => credential });
    const values = await Promise.all(Array.from({ length: 10 }, () => auth.getAccessToken()));
    expect(new Set(values.map((value) => value.token)).size).toBe(1);
    expect(f.issue).toHaveBeenCalledTimes(1);
    const other = cloudIdentityAuth({ endpoint, credential: async () => f.b.credential });
    expect((await other.getAccessToken()).token).toContain("company-b-production");
    const next = createDeploymentCredential();
    f.rows.set(next.hash, { ...enrollment("company-a"), generation: 2 });
    f.rows.delete(f.a.hash);
    credential = next.credential;
    vi.setSystemTime(Date.now() + 550_000);
    expect((await auth.getAccessToken()).token).toContain("company-a-production");
    expect(f.issue).toHaveBeenCalledTimes(3);
    expect(f.events.at(-1)?.enrollment?.generation).toBe(2);
  });
  it("fails closed through outages, expired credentials and revocation without ambient fallback", async () => {
    const f = fixture();
    const transport = vi.fn<typeof fetch>(async (url, init) => f.broker(new Request(url, init)));
    vi.stubGlobal("fetch", transport);
    const auth = cloudIdentityAuth({ endpoint, credential: async () => f.a.credential });
    await auth.getAccessToken();
    vi.setSystemTime(Date.now() + 610_000);
    transport.mockRejectedValueOnce(new Error(`synthetic-secret:${f.a.credential}`));
    const error = await auth.getAccessToken().catch((failure: unknown) => failure);
    expect(String(error)).toBe("CloudIdentityError: Cloud identity unavailable");
    expect(error).not.toHaveProperty("cause");
    f.rows.delete(f.a.hash);
    await expect(auth.getAccessToken()).rejects.toThrow("Cloud identity unavailable");
    expect(f.issue).toHaveBeenCalledTimes(1);
  });
  it("rejects insecure endpoints and malformed or nearly expired broker replies", async () => {
    for (const url of [
      "http://issuer.example.test/token",
      `${endpoint}?account=b`,
      "https://user:pass@issuer.example.test/token",
      "https://issuer.example.test/other",
    ]) {
      expect(() => cloudIdentityAuth({ endpoint: url, credential: async () => "" })).toThrow(
        "Cloud identity unavailable",
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Response.json({ accessToken: "synthetic", expiresAt: Date.now() + 10_000 })),
    );
    const auth = cloudIdentityAuth({ endpoint, credential: async () => createDeploymentCredential().credential });
    await expect(auth.getAccessToken()).rejects.toThrow("Cloud identity unavailable");
    expect(fetch).toHaveBeenCalledWith(
      new URL(endpoint),
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });
});
