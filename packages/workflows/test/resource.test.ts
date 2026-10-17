import { withFake } from "@sanoma-ai/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import { defineFake } from "../src/fake.ts";
import {
  allowAll,
  compareDeclared,
  defineConfig,
  diffDeclared,
  defineConnector,
  defineDriver,
  defineResource,
  defineWorkflow,
  memoryLedger,
  resolveConfig,
  withSetup,
} from "../src/index.ts";
import { VENDOR } from "../src/op.ts";
import { DECLARED, isChangeOp, resourceTypesOf, withoutWriteOnly } from "../src/resource.ts";
import { secret } from "../src/secret.ts";

const fields = {
  immutable: ["name"],
  vendorOwned: ["url", "pages.status"],
  writeOnly: ["token"],
  unordered: ["topics", "rules"],
};

const repo = defineResource({
  vendor: "acme",
  type: "repo",
  title: "Repo",
  identity: "name",
  schema: z.object({
    name: z.string(),
    wiki: z.boolean().nullish(),
    etag: z.string().nullish(),
    url: z.string().nullish(),
    token: z.string().nullish(),
    topics: z.array(z.string()).nullish(),
    pages: z.object({ cname: z.string().nullish(), status: z.string().nullish() }).nullish(),
    rules: z.array(z.object({ pattern: z.string(), strict: z.boolean().nullish() })).nullish(),
  }),
  fields,
  find: ({ name }) => name,
});

const acme = defineConnector("acme", { repo }, { title: "Acme", package: "@acme/sanoma-connector" });

describe("defineResource", () => {
  it("derives read and import operations, effect read and idempotent, targeting the import id", () => {
    expect(acme.repo.read).toMatchObject({ id: "acme.repo.read", effect: "read", idempotent: true });
    expect(acme.repo.import).toMatchObject({
      id: "acme.repo.import",
      effect: "read",
      idempotent: true,
      description: "Find a repo by its name or its binding id and read it; gone when there is none",
      opaque: ["handle"],
    });
    expect(acme.repo.read.description).toBe("Read a repo as it is now; gone when it no longer exists");
    expect(acme.repo.read.target?.({ id: "sanoma" })).toBe("sanoma");
  });

  it("types the operations' state with the resource's schema", () => {
    expect(acme.repo.import.input.safeParse({ id: "sanoma" }).success).toBe(true);
    expect(
      acme.repo.import.output.safeParse({ id: "sanoma", gone: false, state: { name: "sanoma" }, handle: "1:e30=" })
        .success,
    ).toBe(true);
    expect(acme.repo.import.output.safeParse({ id: "sanoma", gone: false, state: { wiki: true } }).success).toBe(false);
    // Like read, import answers gone when the vendor has no such object.
    expect(acme.repo.import.output.safeParse({ id: "sanoma", gone: true }).success).toBe(true);
    expect(acme.repo.read.output.safeParse({ id: "sanoma", gone: true }).success).toBe(true);
    expect(acme.repo.read.input.safeParse({ id: "sanoma", state: { name: "sanoma" }, handle: "1:e30=" }).success).toBe(
      true,
    );
    // The handle is opaque: the driver's, not the runtime's.
    expect(acme.repo.read.input.safeParse({ id: "sanoma", handle: 1 }).success).toBe(false);
  });

  it("is a connector's group under its type, of its vendor only", () => {
    expect(acme[VENDOR].resources).toEqual([repo]);
    expect(defineConnector("plain", {})[VENDOR].resources).toEqual([]);
    const info = { package: "@other/connector" };
    expect(() => defineConnector("other", { repo }, info)).toThrow(
      'defineConnector("other"): repo is a resource type of acme',
    );
    expect(() => defineConnector("acme", { repository: repo }, info)).toThrow(
      'defineConnector("acme"): the resource type repo is given as repository',
    );
  });

  it("needs the connector's package, whose `/resources` entry data files import the types from", () => {
    expect(() => defineConnector("acme", { repo }, { title: "Acme" })).toThrow(
      'defineConnector("acme"): a connector with resource types needs info.package',
    );
  });

  it("declares a resource for a data file, branded and named by its identity", () => {
    const site = repo({ name: "sanoma", wiki: false });
    expect(site).toEqual({
      [DECLARED]: "acme.repo",
      vendor: "acme",
      type: "repo",
      name: "sanoma",
      desired: { name: "sanoma", wiki: false },
      refs: {},
    });
    expect(site[DECLARED]).toBe("acme.repo");
    expect(Object.isFrozen(site)).toBe(true);
  });

  it("refuses fields the schema does not have, values it rejects, and an empty identity", () => {
    expect(() => repo({ name: "x", wikki: true } as never)).toThrow("acme.repo: no field wikki");
    expect(() => repo({ name: "x", url: "https://x", pages: { status: "built" } })).toThrow(
      "acme.repo: leave out url, pages.status: the vendor sets them",
    );
    expect(() => repo({ name: "x", wiki: "yes" } as never)).toThrow(/acme\.repo: .*wiki/s);
    expect(() => repo({ name: "" })).toThrow("acme.repo: its name is missing");
  });

  it("takes a secret at a write-only field only, kept as its marker, which the schema does not judge", () => {
    const strict = defineResource({
      vendor: "acme",
      type: "db",
      title: "Database",
      identity: "name",
      schema: z.object({ name: z.string(), password: z.string().min(12), note: z.string().nullish() }),
      fields: { immutable: [], vendorOwned: [], writeOnly: ["password"] },
      find: ({ name }) => name,
    });
    const db = strict({ name: "main", password: secret("DB_PASSWORD", { generate: true }) });
    expect(db.desired).toEqual({ name: "main", password: { $secret: "DB_PASSWORD", generate: true } });
    expect(JSON.parse(JSON.stringify(db.desired))).toEqual(db.desired);
    expect(repo({ name: "x", token: secret("REPO_TOKEN") }).desired).toEqual({
      name: "x",
      token: { $secret: "REPO_TOKEN" },
    });
    // Anywhere else, the type refuses it; the schema still judges the other fields.
    expect(() => strict({ name: "main", password: "short", note: secret("NOTE") })).toThrow(
      "acme.db: note is not write-only, so it takes a value, not a secret (NOTE)",
    );
    expect(() => repo({ name: secret("NAME") })).toThrow("acme.repo: name is not write-only");
    expect(() => repo({ name: "x", topics: [secret("TOPIC")] })).toThrow("acme.repo: topics.0 is not write-only");
    expect(() => strict({ name: "main", password: "short" })).toThrow(/acme\.db: .*password/s);
    expect(() => secret("db_password")).toThrow(/a secret's name is an environment variable's/);
  });

  it("lets a data file name a vendor-owned field its identity is made of", () => {
    const thing = defineResource({
      vendor: "acme",
      type: "thing",
      title: "Thing",
      identity: "id",
      schema: z.object({ id: z.string().nullish(), created: z.number().nullish() }),
      fields: { immutable: [], vendorOwned: ["id", "created"], writeOnly: [] },
      find: ({ id }) => id ?? "",
    });
    expect(thing({ id: "t_1" }).name).toBe("t_1");
    expect(() => thing({ id: "t_1", created: 1 })).toThrow("acme.thing: leave out created: the vendor sets it");
  });

  describe("without find", () => {
    // A type the vendor names alone: its id is vendor-owned, and only a binding finds an object.
    const product = defineResource({
      vendor: "acme",
      type: "product",
      title: "Product",
      schema: z.object({ id: z.string().nullish(), title: z.string(), node: z.string().nullish() }),
      fields: { immutable: [], vendorOwned: ["id", "node"], writeOnly: [] },
    });

    it("declares a resource without a name, refusing the vendor's id, and imports by binding id", () => {
      const pro = product({ title: "Pro" });
      expect(pro).toMatchObject({ vendor: "acme", type: "product", desired: { title: "Pro" } });
      expect(pro).not.toHaveProperty("name");
      expect(() => product({ id: "p_1", title: "Pro" })).toThrow("acme.product: leave out id: the vendor sets it");
      expect(product.ops.import.description).toBe(
        "Find a product by its binding id and read it; gone when there is none",
      );
    });

    it("keeps its state's id as the binding id by default, or what `bindingId` makes of the state", () => {
      expect(product.bindingId({ id: "p_1", title: "Pro" })).toBe("p_1");
      expect(repo.bindingId({ id: 7, name: "sanoma" })).toBe("7");
      const byNode = defineResource({
        vendor: "acme",
        type: "noded",
        title: "Noded",
        schema: z.object({ id: z.string().nullish(), node: z.string().nullish() }),
        fields: { immutable: [], vendorOwned: ["id", "node"], writeOnly: [] },
        bindingId: ({ node }) => String(node),
      });
      expect(byNode.bindingId({ id: "x", node: "N_1" })).toBe("N_1");
    });

    it("cannot be named by another resource: a reference stands for an identity", () => {
      const listing = defineResource({
        vendor: "acme",
        type: "listing",
        title: "Listing",
        identity: "slug",
        schema: z.object({ slug: z.string(), product: z.string().nullish() }),
        fields: { immutable: [], vendorOwned: [], writeOnly: [], references: { product: { type: "acme.product" } } },
        find: ({ slug }) => slug,
      });
      expect(() => listing({ slug: "pro", product: product({ title: "Pro" }) })).toThrow(
        "acme.listing: product names a acme.product, which has no identity to name it by",
      );
    });
  });

  describe("references", () => {
    const rule = defineResource({
      vendor: "acme",
      type: "rule",
      title: "Rule",
      identity: "repository:pattern",
      schema: z.object({
        repository: z.string(),
        pattern: z.string(),
        strict: z.boolean().nullish(),
        note: z.string().nullish(),
        reviewers: z.array(z.object({ repository: z.string(), count: z.number() })).nullish(),
      }),
      fields: {
        immutable: ["repository"],
        vendorOwned: [],
        writeOnly: [],
        references: { repository: { type: "acme.repo" }, "reviewers.repository": { type: "acme.repo" } },
      },
      find: ({ repository, pattern }) => `${repository}:${pattern}`,
    });
    const site = repo({ name: "sanoma" });

    it("take a declared resource where `fields.references` names its type, as its name", () => {
      const main = rule({
        repository: site,
        pattern: "main",
        reviewers: [
          { repository: "docs", count: 1 },
          { repository: site, count: 2 },
        ],
      });
      expect(main.name).toBe("sanoma:main");
      // `desired` holds the name, which the schema and `find` read; `refs` says where it was named.
      expect(main.desired).toEqual({
        repository: "sanoma",
        pattern: "main",
        reviewers: [
          { repository: "docs", count: 1 },
          { repository: "sanoma", count: 2 },
        ],
      });
      expect(main.refs).toEqual({ repository: "acme.repo:sanoma", "reviewers.1.repository": "acme.repo:sanoma" });
    });

    it("are compared as the names they stand for, so a referencing resource does not drift", () => {
      const { desired } = rule({ repository: site, pattern: "main" });
      const state = { ...desired, strict: true, note: "set at the vendor" };
      expect(rule.normalize(state, desired)).toEqual(rule.normalize(desired, desired));
    });

    it("are refused anywhere else, and of another type, by the type as by the constructor", () => {
      const other = rule({ repository: "docs", pattern: "main" });
      // @ts-expect-error note takes no reference
      expect(() => rule({ repository: site, pattern: "main", note: site })).toThrow(
        "acme.rule: note takes a value, not a resource (acme.repo sanoma)",
      );
      // @ts-expect-error repository names an acme.repo
      expect(() => rule({ repository: other, pattern: "main" })).toThrow(
        "acme.rule: repository names a resource of type acme.repo, not acme.rule (docs:main)",
      );
      // @ts-expect-error a repo names no resource
      expect(() => repo({ name: site })).toThrow("acme.repo: name takes a value, not a resource (acme.repo sanoma)");
    });
  });

  it("is implemented by an ordinary driver", () => {
    const driver = defineDriver(acme, {
      repo: {
        import: async ({ id }) => ({ id, gone: false, state: { name: id } }),
        read: async ({ id }) => ({ id, gone: true }),
      },
    });
    expect(Object.keys(driver.ops)).toEqual(["repo.import", "repo.read"]);
  });
});

describe("diffDeclared", () => {
  it("names each declared leaf that differs, a list item's with its index, never a vendor-owned one", () => {
    const desired = { name: "sanoma", wiki: false, url: "x", rules: [{ pattern: "main", strict: true }] };
    const state = { name: "sanoma", wiki: true, url: "y", rules: [{ pattern: "main", strict: false }], etag: "e" };
    // A set (`rules` is one) has no item positions: it differs whole.
    expect(diffDeclared(repo, state, desired)).toEqual([
      { path: "wiki", desired: false, actual: true },
      { path: "rules", desired: desired.rules, actual: state.rules },
    ]);
    const ordered = { ...repo, fields: { ...fields, unordered: [] } };
    expect(diffDeclared(ordered, state, desired)).toEqual([
      { path: "wiki", desired: false, actual: true },
      { path: "rules.0.strict", desired: true, actual: false },
    ]);
  });

  it("takes any value `accept` gives for a reference as the declared one", () => {
    const desired = { name: "sanoma", pages: { cname: "site" } };
    const state = { name: "sanoma", pages: { cname: "R_site" } };
    expect(diffDeclared(repo, state, desired, { "pages.cname": ["site", "R_site"] })).toEqual([]);
    expect(diffDeclared(repo, state, desired, { "pages.cname": ["R_other"] })).toEqual([
      { path: "pages.cname", desired: "site", actual: "R_site" },
    ]);
  });
});

describe("withoutWriteOnly", () => {
  it("drops write-only fields, in list items too, and keeps the rest", () => {
    const nested = { ...fields, writeOnly: ["token", "rules.secret"] };
    expect(withoutWriteOnly(nested, { name: "sanoma", token: "t", rules: [{ pattern: "main", secret: "s" }] })).toEqual(
      { name: "sanoma", rules: [{ pattern: "main" }] },
    );
  });

  it("keeps a secret's marker, which names a stored value and holds none", () => {
    const nested = { ...fields, writeOnly: ["token"] };
    expect(withoutWriteOnly(nested, { name: "sanoma", token: { $secret: "TOKEN" } })).toEqual({
      name: "sanoma",
      token: { $secret: "TOKEN" },
    });
    // A map of secrets keeps its markers, and loses any value.
    const env = { ...fields, writeOnly: ["env"] };
    expect(withoutWriteOnly(env, { name: "app", env: { KEY: { $secret: "KEY" }, PLAIN: "x" } })).toEqual({
      name: "app",
      env: { KEY: { $secret: "KEY" } },
    });
    expect(withoutWriteOnly(env, { name: "app", env: { PLAIN: "x" } })).toEqual({ name: "app" });
  });
});

describe("compareDeclared", () => {
  const actual = {
    name: "sanoma",
    wiki: true,
    etag: 'W/"7c93"',
    url: "https://acme.example/sanoma",
    token: null,
    topics: ["b", "a"],
    pages: { cname: "docs.example", status: "built" },
    rules: [{ pattern: "main", strict: true }],
  };

  it("compares declared fields only, so a computed and optional field left out is never drift", () => {
    expect(compareDeclared(fields, actual, { name: "sanoma", wiki: false })).toEqual({ name: "sanoma", wiki: true });
    expect(repo.normalize(actual, { name: "sanoma" })).toEqual({ name: "sanoma" });
  });

  it("compares a computed and optional field once it is declared", () => {
    expect(compareDeclared(fields, actual, { name: "sanoma", etag: "x" })).toEqual({
      name: "sanoma",
      etag: 'W/"7c93"',
    });
  });

  it("never compares vendor-owned or write-only fields, at any depth", () => {
    const desired = { name: "sanoma", url: "x", token: "t", pages: { cname: "docs.example", status: "x" } };
    expect(compareDeclared(fields, actual, desired)).toEqual({ name: "sanoma", pages: { cname: "docs.example" } });
  });

  it("picks list items against the declared item at the same index, and keeps other values whole", () => {
    const ordered = { ...fields, unordered: [] };
    expect(compareDeclared(ordered, actual, { name: "sanoma", rules: [{ pattern: "main" }], topics: ["a"] })).toEqual({
      name: "sanoma",
      rules: [{ pattern: "main" }],
      topics: ["b", "a"],
    });
  });

  it("compares a set in any order, as a multiset", () => {
    const state = {
      ...actual,
      rules: [
        { pattern: "v*", strict: false },
        { pattern: "main", strict: true },
      ],
    };
    const desired = { name: "sanoma", topics: ["a", "b"], rules: [{ pattern: "main" }, { pattern: "v*" }] };
    expect(repo.normalize(state, desired)).toEqual(repo.normalize(desired, desired));
    expect(repo.normalize(state, desired)).toEqual({
      name: "sanoma",
      topics: ["a", "b"],
      rules: [{ pattern: "main" }, { pattern: "v*" }],
    });
    // A repeated item counts: ["a", "a"] is not ["a"].
    expect(repo.normalize({ name: "sanoma", topics: ["a", "a"] }, { name: "sanoma", topics: ["a"] })).not.toEqual(
      repo.normalize({ name: "sanoma", topics: ["a"] }, { name: "sanoma", topics: ["a"] }),
    );
  });

  it("gives what was declared when given it twice, for the other side of the comparison", () => {
    const desired = { name: "sanoma", url: "x", wiki: false };
    expect(compareDeclared(fields, desired, desired)).toEqual({ name: "sanoma", wiki: false });
  });
});

describe("describeConfig with resources", () => {
  it("lists the resource types once, top level, and refers to their state from their operations", () => {
    const config = defineConfig({
      workflows: [],
      connectors: [
        withFake(
          acme,
          defineFake(acme, {
            initial: () => ({}),
            ops: () => ({
              repo: {
                import: async ({ id }) => ({ id, gone: false, state: { name: id } }),
                read: async ({ id }) => ({ id, gone: true }),
              },
            }),
          }),
        ),
        defineConnector("plain", {}),
      ],
      policy: allowAll,
      ledger: memoryLedger(),
    });
    const { resourceTypes, ops } = describeConfig(config);
    expect(resourceTypes).toEqual([
      {
        id: "acme.repo",
        vendor: "acme",
        type: "repo",
        title: "Repo",
        identity: "name",
        fields,
        schema: expect.objectContaining({ $id: "sanoma:resource-type/acme.repo", type: "object" }),
        ops: ["acme.repo.import", "acme.repo.read"],
      },
    ]);
    expect(resourceTypes[0]?.schema).toMatchObject({ properties: { name: { type: "string" } } });
    expect(ops.map((op) => op.id)).toEqual(["acme.repo.import", "acme.repo.read"]);
    // The operations refer to the state's schema rather than repeating it.
    const read = ops.find((op) => op.id === "acme.repo.read");
    expect(read?.output).toMatchObject({ properties: { state: { $ref: "sanoma:resource-type/acme.repo" } } });
    expect(JSON.stringify(read?.output)).not.toContain('"wiki"');
  });
});

describe("a writable resource type", () => {
  const box = defineResource({
    vendor: "crate",
    type: "box",
    title: "Box",
    identity: "name",
    schema: z.object({ name: z.string(), size: z.number().nullish(), id: z.string().nullish() }),
    fields: { immutable: ["size"], vendorOwned: ["id"], writeOnly: [] },
    find: ({ name }) => name,
    writable: true,
  });
  const crate = defineConnector("crate", { box }, { package: "@crate/connector" });
  const state = { name: "a", size: 1, id: "b-1" };
  const driver = defineDriver(crate, {
    box: {
      import: async ({ id }) => ({ id, gone: false, state }),
      read: async ({ id }) => ({ id, gone: false, state }),
      plan: async () => ({
        action: "create" as const,
        planned: { name: "a", size: 1, id: null },
        unknown: ["id"],
        replace: [],
      }),
      create: async () => ({ id: "b-1", state }),
      update: async ({ id }) => ({ id, state }),
      delete: async ({ id }) => ({ id, gone: true as const }),
    },
  });
  const changeWorkflow = defineWorkflow({
    name: "boxes",
    trigger: "manual",
    input: z.object({}),
    uses: [crate.box.create],
    run: async (ctx) => ctx.crate.box.create({ desired: { name: "a" } }),
  });

  it("has plan, read, idempotent, and create, update and delete, effect write (delete idempotent), besides read and import", () => {
    expect(Object.keys(crate.box).toSorted()).toEqual(["create", "delete", "import", "plan", "read", "update"]);
    expect(box.writable).toBe(true);
    expect(repo.writable).toBe(false);
    expect(crate.box.plan).toMatchObject({ effect: "read", idempotent: true, opaque: ["handle"] });
    for (const name of ["create", "update", "delete"] as const) {
      // A delete reads first, so a retry finds the object gone.
      expect(crate.box[name]).toMatchObject({ effect: "write", idempotent: name === "delete", opaque: ["handle"] });
    }
    // A create's target is its type: the object has no id yet.
    expect(crate.box.create.target?.({ desired: {} })).toBe("new:crate.box");
    expect(crate.box.plan.target?.({ desired: {} })).toBe("new:crate.box");
    expect(crate.box.plan.target?.({ id: "b-1" })).toBe("b-1");
    expect(crate.box.delete.target?.({ id: "b-1" })).toBe("b-1");
    expect(isChangeOp(crate.box.update, resourceTypesOf([crate]))).toBe(true);
    expect(isChangeOp(crate.box.plan, resourceTypesOf([crate]))).toBe(false);
  });

  it("checks what a change returns, and takes secret markers in desired", () => {
    expect(crate.box.update.input.parse({ id: "b-1", desired: { name: "a", token: { $secret: "T" } } })).toBeTruthy();
    expect(() => crate.box.plan.output.parse({ action: "rebuild", unknown: [], replace: [] })).toThrow(/action/);
    expect(() => crate.box.delete.output.parse({ id: "b-1", gone: false })).toThrow(/gone/);
  });

  it("is refused in any workflow's uses but apply's, and listed with its change operations", () => {
    const config = {
      workflows: [changeWorkflow],
      connectors: [withSetup(crate, { driver: () => driver })],
      policy: allowAll,
    };
    expect(() => resolveConfig(config)).toThrow(
      'Workflow "boxes": crate.box.create changes a declared resource, which only apply does: change the data file instead',
    );
    const reading = defineWorkflow({ ...changeWorkflow, name: "plans", uses: [crate.box.plan], run: async () => 1 });
    const { resourceTypes } = describeConfig({ ...config, workflows: [reading], ledger: memoryLedger() });
    expect(resourceTypes[0]?.ops).toEqual([
      "crate.box.create",
      "crate.box.delete",
      "crate.box.import",
      "crate.box.plan",
      "crate.box.read",
      "crate.box.update",
    ]);
  });
});
