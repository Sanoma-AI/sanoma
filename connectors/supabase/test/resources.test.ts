import { readFileSync } from "node:fs";
import { fromTfState } from "@sanoma-ai/bridge/tfschema";
import type { Op } from "@sanoma-ai/workflows";
import { secret } from "@sanoma-ai/workflows/resources";
import { describe, expect, it } from "vitest";
import { supabaseTf } from "../src/connector.ts";
import { supabase } from "../src/index.ts";
import { supabase as declare } from "../src/resources.ts";

const replies = new URL("../testdata/replies/supabase_supabase_1.11.0/", import.meta.url);
const TYPES = supabaseTf.types;

/** The state a read in `testdata/replies` returned, as the provider holds it. */
const replied = (path: string) => {
  const { response } = JSON.parse(readFileSync(new URL(path, replies), "utf8"));
  return JSON.parse(response.resource.stateJson) as Record<string, unknown>;
};

describe("the generated Supabase resource type", () => {
  it("parses a project's read, without its database password", () => {
    const tf = replied("supabase_project/sanomatestprojectref/read.json");
    const state = fromTfState(TYPES.project.shape, { ...tf, database_password: "<scrubbed>" });
    expect(TYPES.project.schema.parse(state)).toMatchObject({
      id: "sanomatestprojectref",
      name: "sanoma-test",
      organization_id: "sanoma-test-org",
      region: "us-east-1",
      database_password: null,
    });
  });

  it("flags the database password write-only, the ref vendor-owned, and the organization and region immutable", () => {
    expect(TYPES.project.fields).toMatchObject({
      writeOnly: ["database_password"],
      vendorOwned: ["id"],
      immutable: ["organization_id", "region"],
    });
  });
});

describe("the supabase connector", () => {
  it("reads and imports a project, effect read, by its ref", () => {
    for (const op of [supabase.project.read, supabase.project.import]) {
      expect(op).toMatchObject({ vendor: "supabase", resource: "project", effect: "read", idempotent: true });
    }
    expect(declare.project.identity).toBeUndefined();
    expect(declare.project.find).toBeUndefined();
  });

  it("changes projects in apply only, and reads the pooler and health and stores the URL through the Management API", () => {
    expect(declare.project.writable).toBe(true);
    // The connector's types do not carry `writable` (`tfConnector`'s), so its change operations are looked up by name.
    const project: Record<string, Op> = supabase.project;
    for (const name of ["create", "update", "delete"]) {
      expect(project[name]).toMatchObject({ effect: "write", resource: "project" });
    }
    expect(project.plan).toMatchObject({ effect: "read", idempotent: true });
    expect(supabase.pooler.get).toMatchObject({ id: "supabase.pooler.get", effect: "read", idempotent: true });
    expect(supabase.project.health).toMatchObject({ id: "supabase.project.health", effect: "read", idempotent: true });
    expect(supabase.database.storeUrl).toMatchObject({ id: "supabase.database.storeUrl", effect: "write" });
    expect(supabase.database.storeUrl.target!({ ref: "abc", export: "store" })).toBe("abc");
    // Its output holds the secret's name alone.
    expect(supabase.database.storeUrl.output.parse({ secret: "S", url: "postgresql://x" })).toEqual({ secret: "S" });
  });

  it("declares a project without an identity, its password a secret: Supabase sets the ref, which only a binding holds", () => {
    const store = declare.project({
      name: "acme-ops",
      organization_id: "acme",
      region: "us-east-1",
      database_password: secret("SUPABASE_DB_PASSWORD", { generate: true }),
    });
    expect(store).not.toHaveProperty("name");
    expect(store.desired).toMatchObject({ name: "acme-ops", organization_id: "acme", region: "us-east-1" });
    expect(() => declare.project({ id: "sanomatestprojectref", name: "acme-ops" } as never)).toThrow(
      "supabase.project: leave out id: the vendor sets it",
    );
    expect(() => declare.project({ name: "acme-ops", region: "us-east-1" } as never)).toThrow("organization_id");
    expect(declare.project.bindingId({ id: "sanomatestprojectref", name: "acme-ops" })).toBe("sanomatestprojectref");
  });
});
