import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { verifyAuthentication } from "@sanoma-ai/workflows";
import { gcpAuthentication, federationCredentials, accountOf, type GcpIdentity } from "../src/authentication.ts";

let directory: string;
const exchanges: string[] = [];
const server = setupServer(
  http.post("https://sts.googleapis.com/v1/token", async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    const subject = form.get("subject_token")!;
    exchanges.push(subject);
    return HttpResponse.json({
      access_token: `federated-${subject}`,
      expires_in: 300,
      token_type: "Bearer",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
  }),
  http.post("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/:target", ({ request, params }) => {
    const expected = String(params.target).startsWith("provision-a@") ? "subject-a" : "subject-b";
    if (request.headers.get("authorization") !== `Bearer federated-${expected}`)
      return HttpResponse.json({ error: { message: "synthetic-secret-never-return" } }, { status: 403 });
    return HttpResponse.json({
      accessToken: "synthetic-short-lived-access",
      expireTime: new Date(Date.now() + 300_000).toISOString(),
    });
  }),
);

export const configFor = (identity: GcpIdentity, sourceFile: string) => ({
  type: "external_account",
  audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/ci/providers/github",
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  token_url: "https://sts.googleapis.com/v1/token",
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${identity.serviceAccount}:generateAccessToken`,
  credential_source: { file: sourceFile, format: { type: "text" } },
});
let a: GcpIdentity, b: GcpIdentity;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sanoma-gcp-auth-"));
  a = {
    project: "company-a",
    projectNumber: "111111",
    serviceAccount: "provision-a@company-a.iam.gserviceaccount.com",
    credentialsFile: join(directory, "a.json"),
  };
  b = {
    project: "company-b",
    projectNumber: "222222",
    serviceAccount: "provision-b@company-b.iam.gserviceaccount.com",
    credentialsFile: join(directory, "b.json"),
  };
  for (const [identity, name] of [
    [a, "a"],
    [b, "b"],
  ] as const) {
    const source = join(directory, `${name}.token`);
    await writeFile(source, `subject-${name}`);
    await writeFile(identity.credentialsFile, JSON.stringify(configFor(identity, source)));
  }
  server.listen({ onUnhandledFrame: "error" });
});
afterAll(async () => {
  server.close();
  await rm(directory, { recursive: true, force: true });
});

it("exchanges each selected connection's source and proves impersonation without returning a token", async () => {
  const auth = gcpAuthentication({ "gcp/a": a, "gcp/b": b });
  const result = await Promise.all(
    ["a", "b"].map((name) => verifyAuthentication(auth, undefined, { vendor: "gcp", connectionId: `gcp/${name}` })),
  );
  expect(result).toEqual([
    { account: accountOf(a), scopes: [] },
    { account: accountOf(b), scopes: [] },
  ]);
  expect(exchanges).toEqual(expect.arrayContaining(["subject-a", "subject-b"]));
  expect(JSON.stringify(result)).not.toContain("synthetic-short-lived-access");
  await expect(verifyAuthentication(auth)).rejects.toMatchObject({ problem: "missing" });
  await expect(
    verifyAuthentication(auth, undefined, { vendor: "gcp", connectionId: "gcp/missing" }),
  ).rejects.toMatchObject({ problem: "missing" });
});

it("rejects key files, changed impersonation targets and executable credential sources", async () => {
  const identity = { ...a, credentialsFile: join(directory, "invalid.json") };
  const valid = configFor(a, join(directory, "a.token"));
  for (const invalid of [
    { type: "service_account", private_key: "synthetic-private-key" },
    { ...valid, service_account_impersonation_url: configFor(b, "unused").service_account_impersonation_url },
    { ...valid, credential_source: { executable: { command: "must-not-run" } } },
    { ...valid, token_url: "https://untrusted.example.test/token" },
  ]) {
    await writeFile(identity.credentialsFile, JSON.stringify(invalid));
    await expect(federationCredentials(identity)).rejects.toMatchObject({ problem: "rejected" });
  }
});

it("does not treat a configured target as verified when Google denies impersonation", async () => {
  const identity = { ...a, credentialsFile: join(directory, "denied.json") };
  await writeFile(identity.credentialsFile, JSON.stringify(configFor(a, join(directory, "b.token"))));
  const error = await verifyAuthentication(gcpAuthentication({ "gcp/a": identity }), undefined, {
    vendor: "gcp",
    connectionId: "gcp/a",
  }).catch((e) => e);
  expect(error).toMatchObject({ problem: "unavailable" });
  expect(String(error)).not.toContain("synthetic-secret-never-return");
  expect(error).not.toHaveProperty("cause");
});
