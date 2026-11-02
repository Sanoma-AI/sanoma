import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { BridgeError } from "@sanoma-ai/bridge";
import { stateBridge } from "@sanoma-ai/bridge/fake";
import { memorySecrets, type CallContext, type Driver } from "@sanoma-ai/workflows";
import { gcpDriver } from "../src/driver.ts";
import { gcpTf } from "../src/connector.ts";
import { fakeGcp } from "../src/fake.ts";
import { accountOf, type GcpIdentity } from "../src/authentication.ts";

let directory: string;
let a: GcpIdentity, b: GcpIdentity;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "sanoma-gcp-driver-"));
  const identities = await Promise.all(
    ["a", "b"].map(async (name) => {
      const identity = {
        project: `company-${name}`,
        projectNumber: name === "a" ? "111111" : "222222",
        serviceAccount: `provision-${name}@company-${name}.iam.gserviceaccount.com`,
        credentialsFile: join(directory, `${name}.json`),
      };
      await writeFile(
        identity.credentialsFile,
        JSON.stringify({
          type: "external_account",
          audience: "//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/ci/providers/github",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          token_url: "https://sts.googleapis.com/v1/token",
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${identity.serviceAccount}:generateAccessToken`,
          credential_source: { file: join(directory, `${name}.token`) },
        }),
      );
      return identity;
    }),
  );
  a = identities[0]!;
  b = identities[1]!;
});
afterAll(() => rm(directory, { recursive: true, force: true }));
let sequence = 0;
const context = (identity: GcpIdentity, name = identity === a ? "a" : "b"): CallContext => ({
  idempotencyKey: `run:${name}:${++sequence}`,
  runId: "run",
  opId: "gcp.keyRing.read",
  attempt: 1,
  secrets: memorySecrets(),
  connection: {
    id: `gcp/${name}`,
    vendor: "gcp",
    method: "workloadIdentity",
    account: accountOf(identity),
    scopes: [],
    revision: "1",
    definition: "fixture",
  },
  authentication: { method: "workloadIdentity", kind: "workload-identity" },
});
const bridgeFor = () =>
  stateBridge({ objects: {} }, [], Object.fromEntries(Object.values(gcpTf.types).map((type) => [type.typeName, type])));
const invoke = (driver: Driver, op: string, input: unknown, call = context(a)) => driver.ops[op]!(input, call);
const ring = (project = "company-a") => `projects/${project}/locations/global/keyRings/credentials`;
const key = () => `${ring()}/cryptoKeys/company`;

const missingMember = {
  severity: "error" as const,
  summary:
    'Cannot find binding for "resource" with role "roles/viewer", member "serviceAccount:runtime@company-a.iam.gserviceaccount.com", and condition title ""',
  detail: "",
  attributePath: "",
};

it.each(["keyIamMember", "serviceAccountIamMember"])(
  "treats a confirmed absent %s as gone for read, plan and idempotent delete",
  async (type) => {
    const bridge = bridgeFor();
    const parent =
      type === "keyIamMember" ? key() : "projects/company-a/serviceAccounts/runtime@company-a.iam.gserviceaccount.com";
    const desired = {
      [type === "keyIamMember" ? "crypto_key_id" : "service_account_id"]: parent,
      role: "roles/viewer",
      member: "serviceAccount:runtime@company-a.iam.gserviceaccount.com",
    };
    const id = [parent, desired.role, desired.member].join(" ");
    vi.spyOn(bridge, "import").mockRejectedValue(
      new BridgeError("failed_precondition", "provider error", [missingMember]),
    );
    const apply = vi.spyOn(bridge, "apply");
    const driver = gcpDriver({ "gcp/a": a }, bridge);
    expect(await invoke(driver, `${type}.read`, { id })).toMatchObject({ id, gone: true });
    expect(await invoke(driver, `${type}.plan`, { id, desired })).toMatchObject({ action: "create" });
    await invoke(driver, `${type}.delete`, { id });
    expect(apply).not.toHaveBeenCalled();
    await invoke(driver, `${type}.create`, { desired });
    expect(apply).toHaveBeenCalledTimes(1);
  },
);

it.each([
  new BridgeError("permission_denied", "synthetic-bearer-token", [missingMember]),
  new BridgeError("failed_precondition", missingMember.summary),
  new BridgeError("failed_precondition", "synthetic-bearer-token", [
    { ...missingMember, summary: 'Cannot import IAM member with condition title "x", it matches multiple conditions' },
  ]),
  new BridgeError("failed_precondition", "synthetic-bearer-token", [{ ...missingMember, detail: "permission denied" }]),
  new BridgeError("failed_precondition", "synthetic-bearer-token", [
    missingMember,
    { ...missingMember, summary: "permission denied" },
  ]),
  new BridgeError("failed_precondition", "synthetic-bearer-token", [
    { ...missingMember, summary: missingMember.summary + " permission denied" },
  ]),
])("preserves and sanitizes IAM import failures instead of reporting absence (%#)", async (failure) => {
  const bridge = bridgeFor();
  vi.spyOn(bridge, "import").mockRejectedValue(failure);
  const apply = vi.spyOn(bridge, "apply");
  const driver = gcpDriver({ "gcp/a": a }, bridge);
  for (const type of ["keyIamMember", "serviceAccountIamMember"])
    await expect(invoke(driver, `${type}.read`, { id: key() })).rejects.toThrow(`gcp: ${type}.read failed`);
  expect(apply).not.toHaveBeenCalled();
});

it("does not classify another resource's IAM-like diagnostic as absence", async () => {
  const bridge = bridgeFor();
  vi.spyOn(bridge, "import").mockRejectedValue(
    new BridgeError("failed_precondition", "provider error", [missingMember]),
  );
  await expect(invoke(gcpDriver({ "gcp/a": a }, bridge), "cryptoKey.read", { id: key() })).rejects.toThrow(
    "gcp: cryptoKey.read failed",
  );
});

it.each([
  {
    type: "keyIamMember",
    parentField: "crypto_key_id",
    parent: "projects/company-a/locations/global/keyRings/credentials/cryptoKeys/company",
    role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
    member: "serviceAccount:runtime@company-a.iam.gserviceaccount.com",
  },
  {
    type: "serviceAccountIamMember",
    parentField: "service_account_id",
    parent: "projects/company-a/serviceAccounts/runtime@company-a.iam.gserviceaccount.com",
    role: "projects/company-a/roles/issuer",
    member:
      "principal://iam.googleapis.com/projects/111111/locations/global/workloadIdentityPools/provisioning/subject/source",
  },
])(
  "returns importable $type IDs for create/read/plan/delete, including custom roles and conditions",
  async ({ type, parentField, parent, role, member }) => {
    for (const condition of [
      undefined,
      { title: "runtime issuer", expression: "true", description: "bounded / proof" },
    ]) {
      const bridge = bridgeFor();
      const driver = gcpDriver({ "gcp/a": a }, bridge);
      const desired = { [parentField]: parent, role, member, ...(condition && { condition }) };
      const created = (await invoke(driver, `${type}.create`, { desired })) as {
        id: string;
        state: Record<string, unknown>;
      };
      const expected = [parent, role, member, ...(condition ? [condition.title] : [])].join(" ");
      expect(created.id).toBe(expected);
      const nativeId = `${parent}/${role}/${member}${condition ? `/${condition.title}/${condition.description}/${condition.expression}` : ""}`;
      const imported = vi.spyOn(bridge, "import").mockImplementation(async (_ref, typeName, id) => {
        // Match the real provider: a native slash-form state ID is not an import ID.
        if (id !== expected) throw new BridgeError("failed_precondition", "invalid IAM import ID", []);
        return {
          warnings: [],
          resources: [
            {
              typeName,
              schemaVersion: 0,
              private: new Uint8Array(),
              stateJson: JSON.stringify({ ...created.state, id: nativeId, condition: condition ? [condition] : [] }),
            },
          ],
        };
      });
      expect(await invoke(driver, `${type}.read`, { id: created.id })).toMatchObject({
        gone: false,
        state: { id: nativeId, role, member },
      });
      await invoke(driver, `${type}.plan`, { id: created.id, desired });
      await invoke(driver, `${type}.delete`, { id: created.id });
      expect(imported).toHaveBeenCalledTimes(3);
    }
  },
);

it("configures and closes distinct provider sessions for concurrent named accounts", async () => {
  const bridge = bridgeFor();
  const configure = vi.spyOn(bridge, "configure");
  const driver = gcpDriver({ "gcp/a": a, "gcp/b": b }, bridge);
  await Promise.all(
    [a, b].map((identity) => invoke(driver, "keyRing.read", { id: ring(identity.project) }, context(identity))),
  );
  const configurations = configure.mock.calls.map(([ref, json]) => ({
    session: ref.sessionId,
    config: JSON.parse(json),
  }));
  expect(new Set(configurations.map((entry) => entry.session)).size).toBe(2);
  for (const identity of [a, b]) {
    const entry = configurations.find(({ config }) => config.project === identity.project)!;
    expect(JSON.parse(entry.config.credentials).service_account_impersonation_url).toContain(identity.serviceAccount);
    expect(bridge.calls).toContainEqual(
      expect.objectContaining({ method: "close", ref: expect.objectContaining({ sessionId: entry.session }) }),
    );
  }
});

it("refuses absent identities, stale account bindings and cross-project resource input before provider startup", async () => {
  const bridge = bridgeFor();
  const driver = gcpDriver({ "gcp/a": a }, bridge);
  await expect(
    invoke(driver, "keyRing.read", { id: ring() }, { ...context(a), connection: undefined }),
  ).rejects.toMatchObject({ problem: "missing" });
  await expect(
    invoke(
      driver,
      "keyRing.read",
      { id: ring() },
      { ...context(a), connection: { ...context(a).connection!, account: accountOf(b) } },
    ),
  ).rejects.toMatchObject({ problem: "wrong_account" });
  for (const input of [
    { id: ring("company-b") },
    { id: ring(), state: { id: ring("company-b") } },
    { desired: { name: "credentials", location: "global", project: "company-b" } },
  ])
    await expect(invoke(driver, "keyRing.read", input)).rejects.toMatchObject({ problem: "wrong_account" });
  expect(bridge.calls).toEqual([]);
});

it("pins symmetric KMS keys to PREVENT and blocks deletion, asymmetric keys and permissive OIDC trust", async () => {
  const bridge = bridgeFor();
  const plan = vi.spyOn(bridge, "plan");
  const driver = gcpDriver({ "gcp/a": a }, bridge);
  await invoke(driver, "cryptoKey.plan", {
    desired: { name: "company", key_ring: ring(), rotation_period: "7776000s" },
  });
  expect(JSON.parse(plan.mock.calls[0]![2].configJson!)).toMatchObject({
    deletion_policy: "PREVENT",
    rotation_period: "7776000s",
  });
  for (const op of ["cryptoKey.delete", "keyRing.delete"])
    await expect(invoke(driver, op, { id: key() })).rejects.toThrow("retire KMS");
  for (const desired of [
    { purpose: "ASYMMETRIC_SIGN" },
    { version_template: { algorithm: "RSA_SIGN_PSS_2048_SHA256" } },
    { deletion_policy: "DELETE" },
  ])
    await expect(
      invoke(driver, "cryptoKey.create", { desired: { name: "company", key_ring: ring(), ...desired } }),
    ).rejects.toMatchObject({ retryable: false });
  await expect(
    invoke(driver, "workloadIdentityProvider.create", {
      desired: { oidc: { issuer_uri: "https://token.actions.githubusercontent.com" } },
    }),
  ).rejects.toThrow("attribute condition");
});

it("refuses a provider's replacement plan without applying a delete and scrubs provider failures", async () => {
  const bridge = bridgeFor();
  const driver = gcpDriver({ "gcp/a": a }, bridge);
  vi.spyOn(bridge, "import").mockResolvedValue({
    warnings: [],
    resources: [
      {
        typeName: "google_kms_crypto_key",
        stateJson: JSON.stringify({ id: key(), name: "company", key_ring: ring() }),
        schemaVersion: 0,
        private: new Uint8Array(),
      },
    ],
  });
  vi.spyOn(bridge, "plan").mockResolvedValue({
    plannedStateJson: "{}",
    warnings: [],
    action: "replace",
    requiresReplace: ["name"],
    unknownPaths: [],
    planned: new Uint8Array(),
    plannedPrivate: new Uint8Array(),
    planToken: new Uint8Array(),
  });
  const apply = vi.spyOn(bridge, "apply");
  await expect(
    invoke(driver, "cryptoKey.update", { id: key(), desired: { name: "changed", key_ring: ring() } }),
  ).rejects.toMatchObject({ retryable: false });
  expect(apply).not.toHaveBeenCalled();
  vi.spyOn(bridge, "configure").mockRejectedValue(new BridgeError("unavailable", "synthetic-bearer-token", []));
  const error = await invoke(driver, "keyRing.read", { id: ring() }).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ retryable: true });
  expect(String(error)).not.toContain("synthetic-bearer-token");
  expect(error).not.toHaveProperty("cause");
});

it("runs the fake with synthetic named accounts without reading a credential source", async () => {
  const fake = fakeGcp();
  fake.put("keyRing", ring(), { name: "credentials", location: "global", project: "company-a" });
  const result = await invoke(
    fake.driver,
    "keyRing.read",
    { id: ring() },
    { ...context(a), authentication: undefined },
  );
  expect(result).toMatchObject({ gone: false, state: { name: "credentials" } });
  fake.override("keyRing", ring(), { name: "renamed" });
  expect(await invoke(fake.driver, "keyRing.read", { id: ring() })).toMatchObject({ state: { name: "renamed" } });
  await expect(invoke(fake.driver, "keyRing.delete", { id: ring() })).rejects.toThrow("retire KMS");
  await expect(
    invoke(fake.driver, "keyRing.update", {
      id: ring(),
      desired: { name: "replacement", location: "global", project: "company-a" },
    }),
  ).rejects.toThrow("replacement requires explicit retirement");
});
