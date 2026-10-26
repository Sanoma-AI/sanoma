import { live, replay } from "@sanoma-ai/testing/replay";
import { type CallContext, DriverError, memorySecrets, type Secrets } from "@sanoma-ai/workflows";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { project } from "../src/connector.ts";
import { neonDriver } from "../src/driver.ts";
import { replayOptions, TEST_KEY } from "./replay.ts";

// Replays test/fixtures, written by hand from Neon's API reference (the SDK's bundled OpenAPI
// spec), not recorded: the README says how to record them with a key.

const { server, play, fixture, sent } = replay(replayOptions);

const P = "spring-example-302709";
const BR = "br-wispy-meadow-118737";
const EP = "ep-silent-smoke-806639";
const URL_STORED = `postgresql://neondb_owner:npg_recordedpassword@${EP}.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;
const PROJECTS = "/api/v2/projects";
/** The project as the fixtures' reads give it. */
const STATE = {
  name: "acme-ops",
  region: "aws-us-east-1",
  size: "0.25",
  pg_version: 17,
  id: P,
  host: `${EP}.us-east-1.aws.neon.tech`,
  default_branch_id: BR,
  default_endpoint_id: EP,
  healthy: true,
};
const DESIRED = { name: "acme-ops", region: "aws-us-east-1" };

const callWith = (secrets: Secrets = memorySecrets()): CallContext => ({
  idempotencyKey: "run-1:1",
  runId: "run-1",
  opId: "neon.project",
  attempt: 1,
  secrets,
});
const op = (name: string, input: object, call = callWith(), driver = neonDriver()) => driver.ops[name]!(input, call);
/** The `DriverError` `promise` fails with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => expect.unreachable(),
    (err: DriverError) => err,
  );

describe.skipIf(live)("neonDriver", () => {
  it("creates a project with the key, its size both autoscaling limits, its database and role named", async () => {
    play("create");
    const made = await op("project.create", { desired: { ...DESIRED, size: "0.25" } });
    expect(made).toEqual({ id: P, state: { ...STATE, healthy: false } });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: PROJECTS,
      body: {
        project: {
          name: "acme-ops",
          region_id: "aws-us-east-1",
          default_endpoint_settings: { autoscaling_limit_min_cu: 0.25, autoscaling_limit_max_cu: 0.25 },
          branch: { database_name: "neondb", role_name: "neondb_owner" },
        },
      },
    });
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    // The reply carries the role's password: the state does not.
    expect(JSON.stringify(made)).not.toContain("npg_");
  });

  it("reads a project with its default branch's read-write compute; gone on Neon's 404", async () => {
    play("read");
    expect(await op("project.read", { id: P })).toEqual({ id: P, gone: false, state: STATE });
    expect(sent.map((s) => s.path)).toEqual([
      `${PROJECTS}/${P}`,
      `${PROJECTS}/${P}/branches?limit=10000`,
      `${PROJECTS}/${P}/endpoints`,
    ]);
    play("read-gone");
    expect(await op("project.import", { id: P })).toEqual({ id: P, gone: true });
  });

  it("reads a 404 that is not Neon's as a failure, not as gone", async () => {
    play("not-neon", [{ method: "GET", path: `${PROJECTS}/${P}`, status: 404, body: "<html>Not found</html>" }]);
    expect(await failure(op("project.read", { id: P }))).toMatchObject({ status: 404, retryable: false });
  });

  it("plans a new size as an update, and a new region as a replace", async () => {
    play("plan-resize");
    expect(await op("project.plan", { id: P, desired: { ...DESIRED, size: "1" } })).toEqual({
      action: "update",
      planned: { ...STATE, size: "1" },
      unknown: [],
      replace: [],
    });
    play("plan-move");
    expect(await op("project.plan", { id: P, desired: { ...DESIRED, region: "aws-eu-central-1" } })).toMatchObject({
      action: "replace",
      replace: ["region"],
    });
  });

  it("plans a create with what only Neon sets unknown, and nothing for the same size written another way", async () => {
    expect(await op("project.plan", { desired: DESIRED })).toEqual({
      action: "create",
      planned: {
        ...DESIRED,
        size: "0.25",
        id: null,
        host: null,
        default_branch_id: null,
        default_endpoint_id: null,
        healthy: null,
        pg_version: null,
      },
      unknown: ["id", "host", "default_branch_id", "default_endpoint_id", "healthy", "pg_version"],
      replace: [],
    });
    play("same-size", fixture("read"));
    expect(await op("project.plan", { id: P, desired: { ...DESIRED, size: "0.25-0.25" } })).toMatchObject({
      action: "none",
    });
  });

  it("compares a size as Neon reads it back, and refuses one Neon does not take", () => {
    const desired = { ...DESIRED, size: "0.50" };
    expect(project.normalize({ ...STATE, size: "0.5" }, desired)).toEqual(project.normalize(desired, desired));
    for (const size of ["0", "0.1", "2-1", "big"])
      expect(project.schema.safeParse({ ...DESIRED, size }).success).toBe(false);
    expect(project.schema.safeParse({ ...DESIRED, size: "0.25-2" }).success).toBe(true);
  });

  it("renames and resizes a project: the project's default and its compute", async () => {
    play("update");
    const desired = { name: "acme", region: "aws-us-east-1", size: "1" };
    const updated = await op("project.update", { id: P, desired, expect: { action: "update", replace: [] } });
    expect(updated).toEqual({ id: P, state: { ...STATE, name: "acme", size: "1" } });
    const one = { autoscaling_limit_min_cu: 1, autoscaling_limit_max_cu: 1 };
    expect(sent[3]).toMatchObject({
      method: "PATCH",
      path: `${PROJECTS}/${P}`,
      body: { project: { name: "acme", default_endpoint_settings: one } },
    });
    expect(sent[4]).toMatchObject({
      method: "PATCH",
      path: `${PROJECTS}/${P}/endpoints/${EP}`,
      body: { endpoint: one },
    });
  });

  it("refuses to replace a project, which would leave the data behind", async () => {
    play("update-move");
    const desired = { ...DESIRED, region: "aws-eu-central-1" };
    const err = await failure(
      op("project.update", { id: P, desired, expect: { action: "replace", replace: ["region"] } }),
    );
    expect(err).toMatchObject({ retryable: false, vendorCode: "immutable" });
    expect(err.message).toContain("cannot change a project's region");
  });

  it("is healthy once the default compute has started", async () => {
    play("health");
    expect(await op("project.health", { id: P })).toEqual({ healthy: false, state: "init" });
    expect(await op("project.health", { id: P })).toEqual({ healthy: true, state: "active" });
  });

  it("stores the direct URL, never returning it, and refuses a secret that holds another", async () => {
    play("store-url");
    const secrets = memorySecrets();
    const stored = await op("project.storeUrl", { id: P, export: "store" }, callWith(secrets));
    expect(stored).toEqual({ secret: "SANOMA_DATABASE_URL_STORE" });
    expect(await secrets.get("SANOMA_DATABASE_URL_STORE")).toBe(URL_STORED);
    expect(sent[0]!.path).toBe(
      `${PROJECTS}/${P}/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false`,
    );
    const other = memorySecrets({ SANOMA_DATABASE_URL_STORE: "postgresql://someone@else/db" });
    expect(await failure(op("project.storeUrl", { id: P, export: "store" }, callWith(other)))).toMatchObject({
      retryable: false,
      vendorCode: "stale",
    });
  });

  it("branches a project with a read-write compute and returns its URL, once", async () => {
    play("branch-create");
    const made = await op("branch.create", { project: P, name: "preview-42", expiresAt: "2026-10-27T12:00:00.000Z" });
    expect(made).toEqual({
      id: "br-aged-salad-637688",
      url: "postgresql://neondb_owner:npg_recordedpassword@ep-little-smoke-851426.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: `${PROJECTS}/${P}/branches`,
      body: { branch: { name: "preview-42", expires_at: "2026-10-27T12:00:00Z" }, endpoints: [{ type: "read_write" }] },
    });
  });

  it("deletes a branch, and a project, as done when Neon has none", async () => {
    play("branch-delete");
    const id = "br-aged-salad-637688";
    expect(await op("branch.delete", { project: P, id })).toEqual({ id, gone: true });
    expect(await op("branch.delete", { project: P, id })).toEqual({ id, gone: true });
    play("delete");
    expect(await op("project.delete", { id: P })).toEqual({ id: P, gone: true });
    expect(await op("project.delete", { id: P })).toEqual({ id: P, gone: true });
  });

  it("suspends and starts a compute, answering the state it goes to", async () => {
    play("suspend-and-start");
    expect(await op("endpoint.suspend", { project: P, id: EP })).toEqual({ state: "idle" });
    expect(await op("endpoint.start", { project: P, id: EP })).toEqual({ state: "active" });
  });

  it("refuses without its key, before any request", async () => {
    vi.stubEnv("NEON_API_KEY", "");
    await expect(op("project.read", { id: P })).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("NEON_API_KEY is not set"),
    });
    expect(sent).toEqual([]);
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [408, true],
    [423, true],
    [429, true],
    [503, true],
  ])("maps a %i to a DriverError, retryable %s, keeping Neon's status and code", async (status, retryable) => {
    const body = { code: "SOME_CODE", message: "said Neon", request_id: "00000000-0000-4000-8000-000000000001" };
    play("status", [{ method: "GET", path: `${PROJECTS}/${P}`, status, body }]);
    const err = await failure(op("project.read", { id: P }));
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({
      status,
      retryable,
      vendorCode: "SOME_CODE",
      message: `neon: GET /projects/${P}: said Neon`,
    });
    // An axios error carries the request's headers, the key among them: it is not kept.
    expect(err.cause).toBeUndefined();
  });

  it("retries no reply and a timeout", async () => {
    server.use(http.all("*", () => HttpResponse.error()));
    expect(await failure(op("project.read", { id: P }))).toMatchObject({ retryable: true });
    server.use(http.all("*", () => delay("infinite")));
    const slow = op("project.read", { id: P }, callWith(), neonDriver({ timeoutMs: 50 }));
    expect(await failure(slow)).toMatchObject({
      retryable: true,
      message: expect.stringContaining("no reply in 50 ms"),
    });
  });
});
