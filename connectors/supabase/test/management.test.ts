import { readFileSync } from "node:fs";
import { live, replay } from "@sanoma-ai/testing/replay";
import { type Driver, memorySecrets, type Secrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { changeReplay } from "../../../packages/bridge/test/change-replay.ts";
import { supabaseDriver } from "../src/driver.ts";
import { provider } from "../src/resources.gen.ts";
import { REF, replayOptions } from "./replay.ts";

// The Management API operations over test/fixtures, and a project's create and delete over the
// provider replies in testdata/ (`sanoma-apply-test*`). Both are written by hand in the
// recorders' formats; the README says how to record them.

const { play, sent } = replay(replayOptions);
const fixtures = new URL("../testdata/", import.meta.url);

/** The project the recorded create left, as the provider's import answers it. */
const createdProject = (() => {
  const at = new URL("replies/supabase_supabase_1.11.0/supabase_project/sanoma-apply-test/apply.json", fixtures);
  const { stateJson } = JSON.parse(readFileSync(at, "utf8")).response.resource;
  return { typeName: "supabase_project", stateJson, private: new Uint8Array(), schemaVersion: 0 };
})();

let seq = 0;
const call = (driver: Driver, op: string, input: unknown, secrets: Secrets = memorySecrets()): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `supabase.${op}`,
    attempt: 1,
    secrets,
  });

describe("the Management API operations", () => {
  const driver = supabaseDriver({ bridge: changeReplay(fixtures, provider), timeoutMs: live ? 15_000 : 200 });

  it("reads the primary database's session pooler, on port 5432, with the token", async () => {
    play("pooler");
    expect(await call(driver, "pooler.get", { ref: REF })).toEqual({
      host: expect.stringMatching(/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/),
      port: 5432,
      user: `postgres.${REF}`,
      database: "postgres",
    });
    // Compared, not printed: a failure must not show a live token.
    expect(sent[0]!.headers.get("authorization") === `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`).toBe(true);
  });

  it("reads the database's and the pooler's health, healthy only when each is", async () => {
    play("health");
    expect(await call(driver, "project.health", { ref: REF })).toEqual({
      healthy: true,
      services: [
        { name: "db", healthy: true, status: "ACTIVE_HEALTHY" },
        { name: "pooler", healthy: true, status: "ACTIVE_HEALTHY" },
      ],
    });
  });

  it.skipIf(live)("says a project coming up is not healthy, for the services named", async () => {
    play("health-coming-up");
    expect(await call(driver, "project.health", { ref: REF, services: ["db"] })).toEqual({
      healthy: false,
      services: [{ name: "db", healthy: false, status: "COMING_UP" }],
    });
  });

  it.skipIf(live)("fails a missing project for good, and a rate limit retryably, with the status", async () => {
    play("pooler-missing");
    await expect(call(driver, "pooler.get", { ref: "sanomamissingproject" })).rejects.toMatchObject({
      message: "supabase: GET /v1/projects/sanomamissingproject/config/database/pooler answered 404: Project not found",
      retryable: false,
      status: 404,
    });
    play("rate-limit");
    await expect(call(driver, "project.health", { ref: REF })).rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it.skipIf(live)(
    "stores the database URL as a secret, returns only its name, and refuses another URL stored",
    async () => {
      play("pooler");
      const secrets = memorySecrets({ SUPABASE_DB_PASSWORD: "p@ss/word" });
      const out = await call(driver, "database.storeUrl", { ref: REF, export: "opsStore" }, secrets);
      expect(out).toEqual({ secret: "SANOMA_DATABASE_URL_OPS_STORE" });
      expect(await secrets.get("SANOMA_DATABASE_URL_OPS_STORE")).toBe(
        `postgresql://postgres.${REF}:p%40ss%2Fword@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require`,
      );
      expect(JSON.stringify(out)).not.toContain("p%40ss");

      play("pooler");
      const kept = memorySecrets({ SUPABASE_DB_PASSWORD: "x", SANOMA_DATABASE_URL_STORE: "postgresql://kept" });
      await expect(call(driver, "database.storeUrl", { ref: REF, export: "store" }, kept)).rejects.toMatchObject({
        message:
          "supabase: database.storeUrl: SANOMA_DATABASE_URL_STORE holds another URL (another project, pooler or password); delete it to store this one",
        retryable: false,
        vendorCode: "stale",
      });
      expect(await kept.get("SANOMA_DATABASE_URL_STORE")).toBe("postgresql://kept");

      // The same URL stored already: done.
      play("pooler");
      expect(await call(driver, "database.storeUrl", { ref: REF, export: "opsStore" }, secrets)).toEqual(out);
    },
  );

  it.skipIf(live)("refuses to store a URL without the database password, before asking Supabase", async () => {
    play("none", []);
    await expect(call(driver, "database.storeUrl", { ref: REF, export: "store" })).rejects.toMatchObject({
      message: "supabase: database.storeUrl: the secret SUPABASE_DB_PASSWORD is not set",
      retryable: false,
    });
  });
});

/** The recording holds the password scrubbed, so the test's is that. */
const scrubbedPassword = () => memorySecrets({ SUPABASE_DB_PASSWORD: "<scrubbed>" });

describe.skipIf(live)("supabase.project's create and delete", () => {
  const desired = {
    name: "sanoma-apply-test",
    organization_id: "sanoma-test-org",
    region: "us-east-1",
    database_password: { $secret: "SUPABASE_DB_PASSWORD", generate: true },
  };
  let bridge: ReturnType<typeof changeReplay>;
  let driver: Driver;
  beforeEach(() => {
    bridge = changeReplay(fixtures, provider);
    driver = supabaseDriver({ bridge, timeoutMs: 200 });
  });

  it("creates a project once the organization has none of its name (one being deleted is none), bound by its ref, never returning its password", async () => {
    play("projects");
    const created = await call(driver, "project.create", { desired }, scrubbedPassword());
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/projects"]);
    expect(created).toMatchObject({
      id: "sanomaapplytestrefab",
      state: { id: "sanomaapplytestrefab", name: "sanoma-apply-test", database_password: null },
    });
    expect(bridge.calls.map((c) => c.action ?? c.method)).toEqual(["configure", "create", "apply", "close"]);

    // The provider reads a project by importing its ref: here, the one the create applied.
    bridge.import = async () => ({ resources: [createdProject], warnings: [] });
    expect(await call(driver, "project.delete", created, scrubbedPassword())).toEqual({ id: created.id, gone: true });
    expect(bridge.calls.slice(4).map((c) => c.action ?? c.method)).toEqual(["configure", "delete", "apply", "close"]);
  });

  it("refuses to create a project whose name the organization has, before the provider sees it", async () => {
    play("projects-taken");
    await expect(call(driver, "project.create", { desired }, scrubbedPassword())).rejects.toMatchObject({
      message:
        "supabase: project.create: the organization sanoma-test-org has a project named sanoma-apply-test already (sanomaapplytestrefab); bind it instead",
      retryable: false,
      vendorCode: "exists",
    });
    expect(bridge.calls).toEqual([]);
  });
});
