import { loadReplies, stateBridge } from "@sanoma-ai/bridge/fake";
import { type Driver, memorySecrets } from "@sanoma-ai/workflows";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabaseDriver } from "../src/driver.ts";
import { fakeSupabase } from "../src/fake.ts";
import { supabase } from "../src/index.ts";
import { provider } from "../src/resources.gen.ts";

const fixtures = new URL("../testdata/", import.meta.url);
const REF = "sanomatestprojectref";

let seq = 0;
/** Calls one of a driver's operations the way the runtime does. */
const call = (driver: Driver, op: string, input: unknown): Promise<any> =>
  driver.ops[op]!(input, {
    idempotencyKey: `run:${++seq}`,
    runId: "run",
    opId: `supabase.${op}`,
    attempt: 1,
    secrets: memorySecrets(),
  });

describe("supabaseDriver", () => {
  let bridge: ReturnType<typeof stateBridge>;
  const calls = () => bridge.calls.map(({ method, typeName, id }) => [method, typeName, id]);
  beforeEach(() => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "sbp_placeholder");
    bridge = stateBridge(loadReplies(fixtures, provider));
  });

  it("configures the provider with the token, and imports a project by its ref, which reads it too", async () => {
    const configure = vi.spyOn(bridge, "configure");
    const imported = await call(supabaseDriver({ bridge }), "project.import", { id: REF });
    expect(calls()).toEqual([
      ["configure", undefined, undefined],
      ["import", "supabase_project", REF],
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
    expect(calls().slice(1)).toEqual([
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

  it("fails, not retryable, without SUPABASE_ACCESS_TOKEN", async () => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "");
    const err = await call(supabaseDriver({ bridge }), "project.read", { id: REF }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: "supabase: SUPABASE_ACCESS_TOKEN is not set", retryable: false });
    expect(calls()).toEqual([]);
  });

  it("reads through the process's default bridge when given none, and declares the token's variable", () => {
    const driver = supabaseDriver();
    expect(Object.keys(driver.env!.shape)).toEqual(["SUPABASE_ACCESS_TOKEN"]);
    expect(driver.env!.shape.SUPABASE_ACCESS_TOKEN!.safeParse(undefined).success).toBe(false);
    expect(Object.keys(driver.ops)).toEqual(["project.import", "project.read"]);
  });
});

describe("fakeSupabase", () => {
  it("returns a renamed project, as if someone renamed it in the dashboard", async () => {
    vi.stubEnv("SUPABASE_ACCESS_TOKEN", "");
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
});
