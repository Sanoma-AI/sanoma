import { loadReplies, stateBridge } from "sanoma/internal/bridge/fake";
import { type CallAuthentication, type Driver, memorySecrets } from "sanoma/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseDriver } from "../src/driver.ts";
import { fakeSupabase } from "../src/fake.ts";
import { supabase } from "../src/index.ts";
import { provider } from "../src/resources.gen.ts";

const fixtures = new URL("../testdata/", import.meta.url);
const REF = "sanomatestprojectref";

/** A pasted personal access token's connection, as the runtime hands it to each call. */
const pasted: CallAuthentication = {
  method: "accessToken",
  kind: "api-key",
  credentialVersion: "fixture",
  credentials: { accessToken: "sbp_placeholder" },
};

let seq = 0;
/** Calls one of a driver's operations the way the runtime does, with the connection's token. */
const call = (
  driver: Driver,
  op: string,
  input: unknown,
  authentication: CallAuthentication | null = pasted,
): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `supabase.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
    ...(authentication && { authentication }),
  });

describe("supabaseDriver", () => {
  let bridge: ReturnType<typeof stateBridge>;
  const calls = () => bridge.calls.map(({ method, typeName, id }) => [method, typeName, id]);
  beforeEach(() => {
    bridge = stateBridge(loadReplies(fixtures, provider));
  });

  it("configures the provider with the token, and imports a project by its ref, which reads it too", async () => {
    const configure = vi.spyOn(bridge, "configure");
    const imported = await call(supabaseDriver({ bridge }), "project.import", { id: REF });
    expect(calls()).toEqual([
      ["configure", undefined, undefined],
      ["import", "supabase_project", REF],
      ["close", undefined, undefined],
    ]);
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ source: "supabase/supabase", version: "1.11.0" }),
      JSON.stringify({ access_token: "sbp_placeholder", endpoint: null }),
    );
    expect(supabase.project.import.output.parse(imported)).toMatchObject({
      id: REF,
      gone: false,
      state: { id: REF, name: "sanoma-test", region: "us-east-1", database_password: null },
    });
  });

  it("reads a project by importing it again, so the provider answers from the ref alone", async () => {
    const driver = supabaseDriver({ bridge });
    const imported = await call(driver, "project.import", { id: REF });
    const read = await call(driver, "project.read", imported);
    expect(calls().filter(([method]) => method === "import")).toEqual([
      ["import", "supabase_project", REF],
      ["import", "supabase_project", REF],
    ]);
    expect(read).toEqual(imported);
  });

  it("answers gone for a project the provider answers with no name: its answer to a 404", async () => {
    const driver = supabaseDriver({ bridge });
    expect(await call(driver, "project.import", { id: "sanomamissingproject" })).toEqual({
      id: "sanomamissingproject",
      gone: true,
    });
    expect(
      await call(driver, "project.read", {
        id: "sanomamissingproject",
        state: { id: "sanomamissingproject", name: "x" },
      }),
    ).toEqual({ id: "sanomamissingproject", gone: true });
  });

  it("configures the provider with an OAuth grant's access token", async () => {
    const configure = vi.spyOn(bridge, "configure");
    await call(
      supabaseDriver({ bridge }),
      "project.import",
      { id: REF },
      {
        method: "oauth",
        kind: "oauth2",
        credentialVersion: "fixture",
        credentials: { accessToken: "sbp_oauth_placeholder", tokenType: "bearer" },
      },
    );
    expect(configure).toHaveBeenCalledWith(
      expect.anything(),
      JSON.stringify({ access_token: "sbp_oauth_placeholder", endpoint: null }),
    );
  });

  it("refuses, before the provider starts, a call without a connection's token: never the environment", async () => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "sbp_from_the_environment");
    await expect(call(supabaseDriver({ bridge }), "project.read", { id: REF }, null)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(calls()).toEqual([]);
  });

  it("reads through the process's default bridge when given none, and takes no environment variable", () => {
    const driver = supabaseDriver();
    expect(driver.env).toBeUndefined();
    expect(driver.authentication).toEqual(["oauth", "accessToken"]);
    expect(Object.keys(driver.ops).toSorted()).toEqual([
      "database.storeUrl",
      "organization.list",
      "pooler.get",
      "project.create",
      "project.delete",
      "project.health",
      "project.import",
      "project.plan",
      "project.read",
      "project.update",
    ]);
  });
});

describe("fakeSupabase", () => {
  it("returns a renamed project, as if someone renamed it in the dashboard", async () => {
    const fake = fakeSupabase();
    const before = await call(fake.driver, "project.import", { id: REF });
    fake.override("project", REF, { name: "renamed" });
    const after = await call(fake.driver, "project.read", before);
    expect(after.state).toEqual({ ...before.state, name: "renamed" });
    expect(fake.calls.map((c) => c.op)).toEqual(["supabase.project.import", "supabase.project.read"]);
  });

  it("says a removed project is gone, and never returns its database password", async () => {
    const fake = fakeSupabase();
    fake.override("project", REF, { database_password: "not-a-real-one" });
    const read = await call(fake.driver, "project.read", { id: REF });
    expect(read.state).toMatchObject({ name: "sanoma-test", database_password: null });
    fake.remove("project", REF);
    expect(await call(fake.driver, "project.read", read)).toEqual({ id: REF, gone: true });
  });

  it("creates a project apply declared, answers its pooler, health and URL, refuses its twin, and deletes it", async () => {
    const fake = fakeSupabase();
    const driver = fake.driver;
    const secrets = memorySecrets();
    const desired = {
      name: "acme-ops",
      organization_id: "acme",
      region: "eu-west-1",
      database_password: { $secret: "SUPABASE_DB_PASSWORD", generate: true },
    };
    const run = (op: string, input: unknown) =>
      driver.ops[op]!(input, {
        idempotencyKey: `fake:${++seq}`,
        runId: "run",
        opId: `supabase.${op}`,
        attempt: 1,
        secrets,
      }) as Promise<any>;
    expect(await run("project.plan", { desired })).toMatchObject({ action: "create", unknown: ["id"] });
    const created = await run("project.create", { desired });
    expect(created).toMatchObject({ state: { name: "acme-ops", region: "eu-west-1", database_password: null } });
    const ref = created.id;
    expect(await secrets.get("SUPABASE_DB_PASSWORD")).toEqual(expect.any(String));

    expect(await run("project.health", { ref })).toEqual({
      healthy: true,
      services: [
        { name: "db", healthy: true, status: "ACTIVE_HEALTHY" },
        { name: "pooler", healthy: true, status: "ACTIVE_HEALTHY" },
      ],
    });
    const pooler = {
      host: "aws-0-eu-west-1.pooler.supabase.com",
      port: 5432,
      user: `postgres.${ref}`,
      database: "postgres",
    };
    expect(await run("pooler.get", { ref })).toEqual(pooler);
    expect(await run("database.storeUrl", { ref, export: "store" })).toEqual({ secret: "SANOMA_DATABASE_URL_STORE" });
    expect(await secrets.get("SANOMA_DATABASE_URL_STORE")).toMatch(
      new RegExp(`^postgresql://postgres\\.${ref}:[\\w-]+@${pooler.host}:5432/postgres\\?sslmode=require$`),
    );

    await expect(run("project.create", { desired })).rejects.toMatchObject({ vendorCode: "exists" });
    expect(await run("project.delete", created)).toEqual({ id: ref, gone: true });
    await expect(run("pooler.get", { ref })).rejects.toMatchObject({ status: 404, retryable: false });
    expect(fake.calls.map((c) => c.op).at(-1)).toBe("supabase.pooler.get");
  });
});
