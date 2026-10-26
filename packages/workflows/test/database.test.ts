import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type DatabaseSpec, defineConnector, defineResource, resolveConfig } from "../src/index.ts";

// The `Database` contract: what `defineResource` refuses of a database type by itself, and what
// `resolveConfig` refuses once the connector's operations are merged in.

const schema = z.object({
  name: z.string(),
  region: z.string(),
  size: z.string().optional(),
  id: z.string().optional(),
});
const database: DatabaseSpec = {
  capabilities: { pauses: true, branch: false },
  inputs: { region: "region", size: "size" },
  storeUrl: "acme.project.storeUrl",
  regions: ["eu", "us"],
  outputs: (state) => ({ healthy: state.id != null }),
};
type Overrides = Partial<DatabaseSpec> & { writable?: boolean; stateless?: boolean; afterCreate?: string[] };
const projectOf = ({ writable = true, stateless, afterCreate, ...overrides }: Overrides = {}) =>
  defineResource({
    vendor: "acme",
    type: "project",
    title: "Project",
    identity: "name",
    schema,
    fields: { immutable: ["region"], vendorOwned: ["id"], writeOnly: [] },
    find: ({ name }) => name,
    writable,
    ...(stateless !== undefined && { stateless }),
    afterCreate: (afterCreate ?? [overrides.storeUrl ?? database.storeUrl]).map((op) => ({
      op,
      input: ({ id, export: name }) => ({ ref: id, export: name }),
    })),
    database: { ...database, ...overrides },
  });

const storeInput = z.object({ ref: z.string(), export: z.string() });
const storeUrl = (input: z.ZodType = storeInput, group = "project") =>
  defineConnector("acme", {
    [group]: { storeUrl: { effect: "write", idempotent: true, input, output: z.object({}), target: () => "p" } },
  });

/** The connector as its package would export it: the type, with `storeUrl` merged into its group. */
const acmeWith = (ops = storeUrl(), project = projectOf()) => {
  const types = defineConnector("acme", { project }, { package: "@acme/connector" });
  return { ...types, project: { ...types.project, ...ops.project } } as typeof types;
};

describe("a database type", () => {
  it("meets the contract, keeps its database and is not stateless", () => {
    const project = projectOf();
    expect(project.database).toMatchObject({ inputs: { region: "region" }, storeUrl: "acme.project.storeUrl" });
    expect(project.stateless).toBe(false);
  });

  it("takes a size left undefined, as a spread of optional inputs gives it", () => {
    expect(projectOf({ inputs: { region: "region", size: undefined } }).database?.inputs.region).toBe("region");
  });

  it("takes a storeUrl in another group of its vendor (Supabase's database.storeUrl)", () => {
    expect(projectOf({ storeUrl: "acme.database.storeUrl" }).database?.storeUrl).toBe("acme.database.storeUrl");
  });

  it.each<[string, Overrides, RegExp]>([
    ["one apply cannot change", { writable: false }, /it must be writable/],
    ["one apply may recreate without asking", { stateless: true }, /it must not be stateless/],
    ["a region that names no field", { inputs: { region: "zone" } }, /region names no field \(zone\)/],
    ["a size that names no field", { inputs: { region: "region", size: "tier" } }, /size names no field \(tier\)/],
    [
      "a capability that is no boolean",
      { capabilities: { pauses: true } as DatabaseSpec["capabilities"] },
      /capabilities\.branch must be true or false/,
    ],
    [
      "a storeUrl of another vendor",
      { storeUrl: "other.project.storeUrl" },
      /storeUrl must name an operation of its vendor, acme\.<group>\.<op> \(other\.project\.storeUrl\)/,
    ],
    ["a storeUrl that is no id", { storeUrl: "storeUrl" }, /storeUrl must name an operation of its vendor/],
    [
      "a storeUrl that is one of its resource operations",
      { storeUrl: "acme.project.update" },
      /storeUrl must be an operation of its own, not the type's update/,
    ],
    [
      "a storeUrl its afterCreate does not call",
      { afterCreate: [] },
      /afterCreate must call acme\.project\.storeUrl, so apply stores the URL/,
    ],
    ["regions that are no list of names", { regions: [""] }, /regions must be a list of region names/],
    ["outputs that are not a function", { outputs: undefined as never }, /outputs must be a function of the state/],
  ])("is refused with %s", (_, overrides, message) => {
    expect(() => projectOf(overrides)).toThrow(message);
  });

  it("is resolved when its connector has storeUrl, taking a ref or an id and the export", () => {
    expect(() => resolveConfig({ workflows: [], connectors: [acmeWith()] })).not.toThrow();
    const byId = storeUrl(z.object({ id: z.string(), export: z.string() }));
    expect(() => resolveConfig({ workflows: [], connectors: [acmeWith(byId)] })).not.toThrow();
    // Fields with formats of their own: a Neon project id, an export in lower case.
    const formatted = storeUrl(
      z.object({ id: z.string().regex(/^[a-z]+-[a-z]+-\d+$/), export: z.string().regex(/^[a-z]\w*$/) }),
    );
    expect(() => resolveConfig({ workflows: [], connectors: [acmeWith(formatted)] })).not.toThrow();
  });

  it("is refused by resolveConfig when storeUrl is no operation of its connector", () => {
    const types = defineConnector("acme", { project: projectOf() }, { package: "@acme/connector" });
    expect(() => resolveConfig({ workflows: [], connectors: [types] })).toThrow(
      "acme.project: its database's storeUrl, acme.project.storeUrl, is no operation of its connector",
    );
  });

  it("is refused by resolveConfig when storeUrl is another resource type's own operation", () => {
    const other = defineResource({
      vendor: "acme",
      type: "database",
      title: "Database",
      schema: z.object({ name: z.string() }),
      fields: { immutable: [], vendorOwned: [], writeOnly: [] },
    });
    const project = projectOf({ storeUrl: "acme.database.read" });
    expect(() =>
      resolveConfig({
        workflows: [],
        connectors: [defineConnector("acme", { project, database: other }, { package: "@acme/connector" })],
      }),
    ).toThrow("acme.project: its database's storeUrl, acme.database.read, is a resource type's own operation");
  });

  it("is refused by resolveConfig when storeUrl does not take a binding id and an export", () => {
    expect(() =>
      resolveConfig({ workflows: [], connectors: [acmeWith(storeUrl(z.object({ ref: z.string() })))] }),
    ).toThrow("acme.project: its database's storeUrl, acme.project.storeUrl, must take { ref or id, export }");
  });
});
