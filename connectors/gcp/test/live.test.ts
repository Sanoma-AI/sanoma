import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge, type Bridge } from "@sanoma-ai/bridge";
import { memorySecrets, verifyAuthentication, type CallContext } from "@sanoma-ai/workflows";
import { afterAll, describe, it } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { accountOf, gcpAuthentication, type GcpIdentity } from "../src/authentication.ts";
import { gcpDriver } from "../src/driver.ts";
import { provider } from "../src/resources.gen.ts";

const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, "Missing live verification configuration");
  return value;
};

// Explicit live opt-in only. The administrator owns creation/retirement of this disposable ring.
const enabled = process.env.SANOMA_GCP_PROVISION_LIVE === "1";
let bridge: Bridge | undefined;
let directory: string | undefined;
let relay: ReturnType<typeof createServer> | undefined;
afterAll(async () => {
  await bridge?.stop();
  if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe.runIf(enabled)("live GCP provisioning with GitHub OIDC", () => {
  it("provisions through the real provider and renews one session beyond token expiry", async () => {
    let step = "configuration";
    try {
      const project = required("SANOMA_GCP_LIVE_PROJECT");
      const projectNumber = required("SANOMA_GCP_LIVE_PROJECT_NUMBER");
      const serviceAccount = required("SANOMA_GCP_LIVE_PROVISIONER");
      const otherAccount = required("SANOMA_GCP_LIVE_OTHER_ACCOUNT");
      const ring = required("SANOMA_GCP_LIVE_RING");
      const audience = required("SANOMA_GCP_LIVE_AUDIENCE");
      assert.ok(ring.startsWith("projects/" + project + "/locations/"));
      assert.match(required("GITHUB_RUN_ID"), /^\d+$/);
      const request = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
      request.searchParams.set("audience", audience);
      const requestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
      let sourceRequests = 0;
      const nonce = "/" + randomUUID();
      relay = createServer(async (req, res) => {
        if (req.method !== "GET" || req.url !== nonce) {
          res.writeHead(404).end();
          return;
        }
        try {
          const response = await fetch(request, {
            headers: { Authorization: "Bearer " + requestToken },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error();
          const body = (await response.json()) as { value?: string };
          if (!body.value) throw new Error();
          sourceRequests++;
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(body));
        } catch {
          res.writeHead(503).end();
        }
      });
      await new Promise<void>((resolve) => relay!.listen(0, "127.0.0.1", resolve));
      const address = relay.address();
      assert.ok(address && typeof address === "object");
      directory = await mkdtemp(join(tmpdir(), "sanoma-live-oidc-"));
      const config = (target: string) => ({
        type: "external_account",
        audience,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" + target + ":generateAccessToken",
        service_account_impersonation: { token_lifetime_seconds: 600 },
        credential_source: {
          url: "http://127.0.0.1:" + address.port + nonce,
          format: { type: "json", subject_token_field_name: "value" },
        },
      });
      const credentials = config(serviceAccount);
      const credentialsFile = join(directory, "provisioning.json");
      const deniedFile = join(directory, "denied.json");
      await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });
      await writeFile(deniedFile, JSON.stringify(config(otherAccount)), { mode: 0o600 });
      const identity: GcpIdentity = { project, projectNumber, serviceAccount, credentialsFile };
      const identities = { "gcp/provisioning": identity };
      step = "OIDC verification";
      const verified = await verifyAuthentication(gcpAuthentication(identities), undefined, {
        vendor: "gcp",
        connectionId: "gcp/provisioning",
      });
      assert.equal(verified.account, accountOf(identity));
      step = "denied impersonation";
      await assert.rejects(
        new GoogleAuth({
          credentials: config(otherAccount),
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        }).getAccessToken(),
        (error: unknown) => {
          const response = (error as { response?: { status?: number; data?: { error?: { status?: string } } } })
            .response;
          return response?.status === 403 && response.data?.error?.status === "PERMISSION_DENIED";
        },
      );
      await assert.rejects(
        verifyAuthentication(
          gcpAuthentication({
            "gcp/denied": {
              ...identity,
              serviceAccount: otherAccount,
              credentialsFile: deniedFile,
            },
          }),
          undefined,
          { vendor: "gcp", connectionId: "gcp/denied" },
        ),
        { name: "AuthenticationError" },
      );
      step = "provider startup";
      bridge = await startBridge({ logger: () => {}, timeoutMs: 180_000 });
      const driver = gcpDriver(identities, bridge);
      const call: CallContext = {
        idempotencyKey: randomUUID(),
        runId: "live-verification",
        opId: "gcp",
        attempt: 1,
        secrets: memorySecrets(),
        connection: {
          id: "gcp/provisioning",
          vendor: "gcp",
          method: "workloadIdentity",
          account: accountOf(identity),
          scopes: [],
          revision: "1",
          definition: "live-verification",
        },
        authentication: { method: "workloadIdentity", kind: "workload-identity" },
      };
      const invoke = (op: string, input: unknown) => driver.ops[op]!(input, { ...call, opId: "gcp." + op });
      step = "read key ring";
      const ringResult = (await invoke("keyRing.read", { id: ring })) as { gone: boolean };
      assert.equal(ringResult.gone, false);
      const desired = {
        name: "oidc-" + process.env.GITHUB_RUN_ID,
        key_ring: ring,
        purpose: "ENCRYPT_DECRYPT",
        rotation_period: "7776000s",
        version_template: { algorithm: "GOOGLE_SYMMETRIC_ENCRYPTION", protection_level: "SOFTWARE" },
      };
      step = "plan and create key";
      assert.equal(((await invoke("cryptoKey.plan", { desired })) as { action: string }).action, "create");
      const created = (await invoke("cryptoKey.create", { desired })) as { id: string };
      assert.equal(created.id, ring + "/cryptoKeys/" + desired.name);
      step = "update rotation";
      await invoke("cryptoKey.update", { id: created.id, desired: { ...desired, rotation_period: "15552000s" } });
      const read = (await invoke("cryptoKey.read", { id: created.id })) as { state: { rotation_period: string } };
      assert.equal(read.state.rotation_period, "15552000s");
      step = "retention refusal";
      await assert.rejects(invoke("cryptoKey.delete", { id: created.id }), /retire KMS/);
      step = "session renewal";
      const session = { ...provider, sessionId: randomUUID() };
      await bridge.configure(session, JSON.stringify({ project, credentials: JSON.stringify(credentials) }));
      const imported = await bridge.import(session, "google_kms_crypto_key", created.id);
      let state = imported.resources[0]!;
      assert.ok(state);
      const beforeRenewal = sourceRequests;
      // Both the initial GitHub JWT and ten-minute impersonated token expire during this session.
      // Repeated real reads keep the provider session active; no token value enters output.
      const until = Date.now() + 660_000;
      while (Date.now() < until) {
        await delay(30_000);
        const next = await bridge.read(session, state.typeName, state.stateJson, state.private, state.schemaVersion);
        assert.ok(next.resource && !next.gone);
        state = next.resource;
      }
      assert.ok(sourceRequests > beforeRenewal, "Provider did not renew the OIDC source");
      await bridge.close(session);
      console.log(
        JSON.stringify({
          oidcVerified: true,
          deniedOtherImpersonation: true,
          providerCreateReadUpdate: true,
          keyDeletionRefused: true,
          renewedProviderSession: true,
          minimumSessionSeconds: 660,
          syntheticKey: created.id,
        }),
      );
    } catch {
      // Never let SDK/provider errors or credential configuration reach CI diagnostics.
      throw new Error("Live GCP verification failed during " + step);
    }
  }, 900_000);
});
