import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { defineConnection, encodeCredentials, verifyAuthentication } from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { accountOf, checkIdentity, gcpAuthentication, type GcpIdentity } from "../src/authentication.ts";
import { gcp, gcpWithIdentity } from "../src/index.ts";

const issuer = "https://provisioning.example.test/identity";
const identity: GcpIdentity = {
  project: "company-a",
  projectNumber: "111111",
  serviceAccount: "provision-a@company-a.iam.gserviceaccount.com",
  audience: "//iam.googleapis.com/projects/111111/locations/global/workloadIdentityPools/provision/providers/google",
  issuer,
};
const enrolled = "a".repeat(43);
const seen: string[] = [];
const server = setupServer(
  // The provisioning issuer: an enrolled bearer gets a Google OIDC token for the source account.
  http.get(issuer, ({ request }) => {
    const authorization = request.headers.get("authorization")!;
    seen.push(authorization);
    if (authorization !== `Bearer ${enrolled}` && authorization !== `Bearer ${"b".repeat(43)}`)
      return new HttpResponse(null, { status: 401 });
    return HttpResponse.json({ idToken: "subject-a", expiresAt: Date.now() + 3_600_000 });
  }),
  http.post("https://sts.googleapis.com/v1/token", async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    if (form.get("audience") !== identity.audience) return HttpResponse.json({}, { status: 400 });
    return HttpResponse.json({
      access_token: `federated-${form.get("subject_token")}`,
      expires_in: 300,
      token_type: "Bearer",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  }),
  http.post("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/:target", ({ request, params }) => {
    if (
      String(params.target) !== `${identity.serviceAccount}:generateAccessToken` ||
      request.headers.get("authorization") !== "Bearer federated-subject-a"
    )
      return HttpResponse.json({ error: { message: "synthetic-secret-never-return" } }, { status: 403 });
    return HttpResponse.json({
      accessToken: "synthetic-short-lived-access",
      expireTime: new Date(Date.now() + 300_000).toISOString(),
    });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

it("verifies a stored bearer by federating once as the declared identity, returning no token", async () => {
  const method = gcpAuthentication(checkIdentity(identity));
  const result = await verifyAuthentication(method, { bearer: enrolled });
  expect(result).toEqual({ account: accountOf(identity), scopes: [] });
  expect(seen).toEqual([`Bearer ${enrolled}`]);
  expect(JSON.stringify(result)).not.toContain("synthetic-short-lived-access");
});

it("reads the bundle each verification, so a replaced bearer takes effect at once", async () => {
  const method = gcpAuthentication(checkIdentity(identity));
  await verifyAuthentication(method, { bearer: enrolled });
  await verifyAuthentication(method, { bearer: "b".repeat(43) });
  expect(seen).toEqual([`Bearer ${enrolled}`, `Bearer ${"b".repeat(43)}`]);
});

it("refuses a missing or malformed bundle, and a connector without an identity", async () => {
  const method = gcpAuthentication(checkIdentity(identity));
  for (const bundle of [undefined, {}, { bearer: "short" }])
    expect(() => encodeCredentials(method, bundle as never)).toThrow("Secret store: invalid_value");
  await expect(verifyAuthentication(gcpAuthentication(), { bearer: enrolled })).rejects.toMatchObject({
    problem: "missing",
  });
  expect(seen).toEqual([]);
});

it("reports an unenrolled bearer and a denied impersonation as unavailable, sanitized", async () => {
  const method = gcpAuthentication(checkIdentity(identity));
  const unenrolled = await verifyAuthentication(method, { bearer: "c".repeat(43) }).catch((e) => e);
  expect(unenrolled).toMatchObject({ problem: "unavailable" });
  const other = gcpAuthentication(
    checkIdentity({ ...identity, serviceAccount: "other@company-a.iam.gserviceaccount.com" }),
  );
  const denied = await verifyAuthentication(other, { bearer: enrolled }).catch((e) => e);
  expect(denied).toMatchObject({ problem: "unavailable" });
  for (const error of [unenrolled, denied]) {
    expect(String(error)).not.toContain("synthetic-secret-never-return");
    expect(String(error)).not.toContain(enrolled);
    expect(error).not.toHaveProperty("cause");
  }
});

it("refuses identity facts that do not name one account and one HTTPS issuer", () => {
  for (const unsafe of [
    "http://example.test/identity",
    "https://user:pass@example.test/identity",
    "https://example.test/token",
    "https://example.test/identity?target=other",
    "https://example.test/identity#target",
  ])
    expect(() => gcpWithIdentity({ ...identity, issuer: unsafe })).toThrow("Authentication: rejected");
  for (const change of [
    { audience: "other" },
    { project: "X" },
    { projectNumber: "0123" },
    { serviceAccount: "someone@example.test" },
  ])
    expect(() => gcpWithIdentity({ ...identity, ...change })).toThrow("Authentication: rejected");
});

it("declares a connection with a stored credential, never one without", () => {
  const configured = gcpWithIdentity(identity);
  expect(
    defineConnection(configured, {
      name: "provisioning",
      method: "workloadIdentity",
      credentials: secret("GCP_PROVISIONING_AUTH"),
      account: accountOf(identity),
    }),
  ).toMatchObject({ $connection: "gcp/provisioning", credentials: { $secret: "GCP_PROVISIONING_AUTH" } });
  // @ts-expect-error untyped callers are refused at run time too
  expect(() => defineConnection(gcp, { name: "provisioning", method: "workloadIdentity" })).toThrow(
    "Credentials must match the authentication method",
  );
});
