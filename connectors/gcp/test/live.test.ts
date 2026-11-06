import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge, type Bridge } from "@sanoma-ai/bridge";
import { memorySecrets, verifyAuthentication, type CallContext } from "@sanoma-ai/workflows";
import { afterAll, describe, it } from "vitest";
import {
  accountOf,
  checkIdentity,
  federationCredentials,
  gcpAuthentication,
  type GcpIdentity,
} from "../src/authentication.ts";
import { gcpDriver } from "../src/driver.ts";
import { provider } from "../src/resources.gen.ts";

const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, "Missing live verification configuration");
  return value;
};

// Explicit live opt-in only, run by an administrator against the deployed provisioning identity
// service. The administrator owns creation/retirement of the disposable ring.
const enabled = process.env.SANOMA_GCP_PROVISION_LIVE === "1";
let bridge: Bridge | undefined;
afterAll(() => bridge?.stop());

describe.runIf(enabled)("live GCP provisioning through the provisioning identity service", () => {
  it("provisions through the real provider and renews one session beyond token expiry", async () => {
    let step = "configuration";
    try {
      const identity: GcpIdentity = checkIdentity({
        project: required("SANOMA_GCP_LIVE_PROJECT"),
        projectNumber: required("SANOMA_GCP_LIVE_PROJECT_NUMBER"),
        serviceAccount: required("SANOMA_GCP_LIVE_PROVISIONER"),
        audience: required("SANOMA_GCP_LIVE_AUDIENCE"),
        issuer: required("SANOMA_GCP_LIVE_ISSUER"),
      });
      // The provisioning bearer the test is given; a deployment stores it in the connection.
      const bearer = required("SANOMA_GCP_LIVE_BEARER");
      const otherAccount = required("SANOMA_GCP_LIVE_OTHER_ACCOUNT");
      const ring = required("SANOMA_GCP_LIVE_RING");
      assert.ok(ring.startsWith("projects/" + identity.project + "/locations/"));
      const method = gcpAuthentication(identity);
      step = "OIDC verification";
      const verified = await verifyAuthentication(method, { bearer });
      assert.equal(verified.account, accountOf(identity));
      step = "denied impersonation";
      await assert.rejects(
        verifyAuthentication(gcpAuthentication(checkIdentity({ ...identity, serviceAccount: otherAccount })), {
          bearer,
        }),
        { name: "AuthenticationError" },
      );
      step = "provider startup";
      bridge = await startBridge({ logger: () => {}, timeoutMs: 180_000 });
      const driver = gcpDriver(identity, method, bridge);
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
        authentication: { method: "workloadIdentity", kind: "api-key", credentials: { bearer } },
      };
      const invoke = (op: string, input: unknown) => driver.ops[op]!(input, { ...call, opId: "gcp." + op });
      step = "read key ring";
      const ringResult = (await invoke("keyRing.read", { id: ring })) as { gone: boolean };
      assert.equal(ringResult.gone, false);
      const desired = {
        name: "oidc-" + Date.now(),
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
      const credentials = JSON.stringify(federationCredentials(identity, bearer));
      await bridge.configure(session, JSON.stringify({ project: identity.project, credentials }));
      const imported = await bridge.import(session, "google_kms_crypto_key", created.id);
      let state = imported.resources[0]!;
      assert.ok(state);
      // The ten-minute impersonated token expires during this session; repeated real reads keep
      // the provider session active and must renew through the issuer. No token enters output.
      const until = Date.now() + 660_000;
      while (Date.now() < until) {
        await delay(30_000);
        const next = await bridge.read(session, state.typeName, state.stateJson, state.private, state.schemaVersion);
        assert.ok(next.resource && !next.gone);
        state = next.resource;
      }
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
      // Never let SDK/provider errors or credential configuration reach the output.
      throw new Error("Live GCP verification failed during " + step);
    }
  }, 900_000);
});
