import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfig } from "../src/describe.ts";
import {
  allowAll,
  compareDeclared,
  defineConfig,
  defineConnector,
  defineDriver,
  defineResource,
  memoryLedger,
} from "../src/index.ts";

const fields = { immutable: ["name"], vendorOwned: ["url", "pages.status"], writeOnly: ["token"] };

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
  crud: { read: {}, import: { description: "Find a repo by name" } },
});

const acme = defineConnector("acme", { repo: repo.ops }, { title: "Acme" });

describe("defineResource", () => {
  it("derives read and import operations, effect read and idempotent, targeting the import id", () => {
    expect(acme.repo.read).toMatchObject({ id: "acme.repo.read", effect: "read", idempotent: true });
    expect(acme.repo.import).toMatchObject({
      id: "acme.repo.import",
      effect: "read",
      idempotent: true,
      description: "Find a repo by name",
    });
    expect(acme.repo.read.description).toBe("Read a repo as it is now; gone when it no longer exists");
    expect(acme.repo.read.target?.({ id: "sanoma" })).toBe("sanoma");
  });

  it("types the operations' state with the resource's schema", () => {
    expect(acme.repo.import.input.safeParse({ id: "sanoma" }).success).toBe(true);
    expect(
      acme.repo.import.output.safeParse({ id: "sanoma", state: { name: "sanoma" }, schemaVersion: 1 }).success,
    ).toBe(true);
    expect(acme.repo.import.output.safeParse({ id: "sanoma", state: { wiki: true } }).success).toBe(false);
    expect(acme.repo.read.output.safeParse({ id: "sanoma", gone: true }).success).toBe(true);
    expect(acme.repo.read.input.safeParse({ id: "sanoma", state: { name: "sanoma" }, private: "e30=" }).success).toBe(
      true,
    );
  });

  it("declares a resource for a data file as a tagged literal named by its identity", () => {
    expect(repo({ name: "sanoma", wiki: false })).toEqual({
      kind: "resource",
      vendor: "acme",
      type: "repo",
      name: "sanoma",
      desired: { name: "sanoma", wiki: false },
    });
  });

  it("refuses fields the schema does not have, values it rejects, and an empty identity", () => {
    expect(() => repo({ name: "x", wikki: true } as never)).toThrow("acme.repo: no field wikki");
    expect(() => repo({ name: "x", wiki: "yes" } as never)).toThrow(/acme\.repo: .*wiki/s);
    expect(() => repo({ name: "" })).toThrow("acme.repo: its name is missing");
  });

  it("is implemented by an ordinary driver", () => {
    const driver = defineDriver(acme, {
      repo: {
        import: async ({ id }) => ({ id, state: { name: id } }),
        read: async ({ id }) => ({ id, gone: true }),
      },
    });
    expect(Object.keys(driver.ops)).toEqual(["repo.import", "repo.read"]);
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
    expect(compareDeclared(fields, actual, { name: "sanoma", rules: [{ pattern: "main" }], topics: ["a"] })).toEqual({
      name: "sanoma",
      rules: [{ pattern: "main" }],
      topics: ["b", "a"],
    });
  });

  it("gives what was declared when given it twice, for the other side of the comparison", () => {
    const desired = { name: "sanoma", url: "x", wiki: false };
    expect(compareDeclared(fields, desired, desired)).toEqual({ name: "sanoma", wiki: false });
  });
});

describe("describeConfig with resources", () => {
  it("lists each vendor's resource types with their identity", () => {
    const config = defineConfig({
      workflows: [],
      connectors: [acme, defineConnector("plain", {})],
      drivers: [
        defineDriver(acme, {
          repo: {
            import: async ({ id }) => ({ id, state: { name: id } }),
            read: async ({ id }) => ({ id, gone: true }),
          },
        }),
      ],
      policy: allowAll,
      ledger: memoryLedger(),
    });
    const { vendors, ops } = describeConfig(config);
    expect(vendors.acme?.resources).toEqual([{ vendor: "acme", type: "repo", title: "Repo", identity: "name" }]);
    expect(vendors.plain?.resources).toBeUndefined();
    expect(ops.map((op) => op.id)).toEqual(["acme.repo.import", "acme.repo.read"]);
  });
});
