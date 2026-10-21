import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { collection, collectionsFake, recordIssues } from "../src/collection.ts";
import { describeConfig } from "../src/describe.ts";
import { allowAll, defineConnector, memorySecrets, type Op, resolveConfig } from "../src/index.ts";
import { loadScenarios } from "../src/scenario.ts";
import config from "./fixtures/outbound/sanoma.config.ts";
import { outbound } from "./fixtures/outbound/resources/data.ts";
import outboundNext from "./fixtures/outbound/workflows/outbound-next.ts";

// What a collection declares, its operations' schemas and targets, the fake a sandbox run keeps
// its records in, and how a config registers it. Its driver on Postgres is in data.test.ts.

/** `collection()` on a declaration its types would refuse. */
const declared = (declaration: unknown) => () => collection(declaration as never);

const lead = { company: "Acme", contact: "ada@acme.test", stage: "researched", owner: "leon" };
const accepts = (record: unknown) => outbound.save.input.safeParse({ record }).success;
const list = (query: unknown) => outbound.list.input.safeParse(query);

describe("collection()", () => {
  it("refuses a name that is not a lowercase letter, then letters and digits", () => {
    for (const name of ["Outbound", "out-bound", "1leads", "", "out_bound"]) {
      expect(declared({ name, key: "id", fields: { id: "text" } })).toThrow(
        `collection("${name}"): the name must be a lowercase letter, then letters and digits, such as "outbound"`,
      );
    }
    expect(collection({ name: "leads2026", key: "id", fields: { id: "text" } }).name).toBe("leads2026");
  });

  it("refuses a key that is not a required text field", () => {
    const fields = {
      id: "text",
      count: "number",
      who: "person",
      maybe: { type: "text", optional: true },
      stage: { enum: ["a", "b"] },
    };
    for (const key of ["count", "who", "maybe", "stage", "missing", "toString"]) {
      expect(declared({ name: "leads", key, fields })).toThrow(
        `collection("leads"): the key "${key}" must be one of its fields, a required "text" one`,
      );
    }
    expect(collection({ name: "leads", key: "id", fields: { id: { type: "text" } } }).key).toBe("id");
  });

  it("refuses unknown field kinds, a field name it cannot sort or filter by, and no fields", () => {
    const refused = (field: unknown) => declared({ name: "leads", key: "id", fields: { id: "text", f: field } });
    for (const kind of ["string", { type: "json" }, {}, { optional: true }, { type: "text", enum: ["a"] }, ["text"]]) {
      expect(refused(kind)).toThrow(`collection("leads"): the field "f" is ${JSON.stringify(kind)}; a field is one of`);
    }
    expect(refused({ type: "text", optional: false })).toThrow('the field "f" may only be marked `optional: true`');
    expect(refused({ enum: [] })).toThrow('the field "f" needs an enum of distinct strings, at least one');
    expect(refused({ enum: ["a", "a"] })).toThrow("needs an enum of distinct strings");
    expect(refused({ enum: ["a", 1] })).toThrow("needs an enum of distinct strings");
    expect(declared({ name: "leads", key: "id", fields: { id: "text", "-f": "text" } })).toThrow(
      'the field "-f" must be named with letters, digits and _, not a digit first',
    );
    expect(declared({ name: "leads", key: "id", fields: {} })).toThrow(`collection("leads"): it needs fields`);
  });

  it("makes four operations of the vendor data, each with its effect and target", () => {
    const ops: Op[] = [outbound.get, outbound.list, outbound.save, outbound.delete];
    expect(
      ops.map(({ id, vendor, resource, effect, idempotent }) => ({ id, vendor, resource, effect, idempotent })),
    ).toEqual([
      { id: "data.outbound.get", vendor: "data", resource: "outbound", effect: "read", idempotent: true },
      { id: "data.outbound.list", vendor: "data", resource: "outbound", effect: "read", idempotent: true },
      { id: "data.outbound.save", vendor: "data", resource: "outbound", effect: "write", idempotent: true },
      { id: "data.outbound.delete", vendor: "data", resource: "outbound", effect: "write", idempotent: true },
    ]);
    expect(outbound.get.target!({ key: "Acme" })).toBe("data:outbound/Acme");
    expect(outbound.list.target!({ limit: 100 })).toBe("data:outbound");
    expect(outbound.save.target!({ record: lead })).toBe("data:outbound/Acme");
    expect(outbound.delete.target!({ key: "Acme" })).toBe("data:outbound/Acme");
    expect(outbound).toMatchObject({ kind: "collection", name: "outbound", key: "company", title: "Outbound" });
    expect(Object.isFrozen(outbound)).toBe(true);
  });

  it("saves a record its fields accept, and refuses one they do not", () => {
    expect(accepts(lead)).toBe(true);
    expect(accepts({ ...lead, lastTouched: "2026-10-20" })).toBe(true);
    expect(accepts({ ...lead, lastTouched: "2026-10-20T09:30:00+02:00", seats: 12 })).toBe(true);
    expect(accepts({ ...lead, lastTouched: "20 October" })).toBe(false);
    expect(accepts({ ...lead, stage: "maybe" })).toBe(false);
    expect(accepts({ ...lead, seats: "12" })).toBe(false);
    expect(accepts({ ...lead, owner: "" })).toBe(false);
    expect(accepts({ ...lead, company: "" })).toBe(false);
    expect(accepts({ ...lead, nickname: "Ac" })).toBe(false);
    const { contact: _, ...noContact } = lead;
    expect(accepts(noContact)).toBe(false);
  });

  it("lists by fields it has, equal or within a range, sorted either way, 1 to 1000 at a time", () => {
    expect(list({}).data).toEqual({ limit: 100 });
    expect(
      list({ where: { stage: "won", seats: { gte: 5, lt: 10 } }, order: "-lastTouched", limit: 1000 }).success,
    ).toBe(true);
    for (const query of [
      { limit: 0 },
      { limit: 1001 },
      { limit: 1.5 },
      { order: "nickname" },
      { order: "--seats" },
      { where: { nickname: "Ac" } },
      { where: { seats: "5" } },
      { where: { seats: { above: 5 } } },
    ]) {
      expect(list(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("says where a record saved under an older declaration no longer fits", () => {
    expect(recordIssues(outbound, lead)).toEqual([]);
    expect(recordIssues(outbound, { ...lead, stage: "maybe", nickname: "Ac", contact: undefined })).toEqual([
      { path: ["contact"], message: expect.any(String) },
      { path: ["stage"], message: expect.any(String) },
      { path: [], message: expect.stringContaining("nickname") },
    ]);
  });
});

describe("the collections' fake", () => {
  const fake = collectionsFake([outbound]);
  let n = 0;
  const call = async (op: Op, input: unknown, by?: string) => {
    const fn = fake.driver.ops[`${op.resource}.${op.name}`]!;
    const context = { idempotencyKey: `t:${n++}`, runId: "t", opId: op.id, attempt: 1, secrets: memorySecrets() };
    return op.output.parse(await fn(op.input.parse(input), by === undefined ? context : { ...context, by }));
  };
  const keys = async (query: unknown) => ((await call(outbound.list, query)) as { key: string }[]).map((s) => s.key);

  it("saves, gets, lists and deletes, as the driver on Postgres does", async () => {
    fake.reset();
    expect(await call(outbound.get, { key: "Acme" })).toBeNull();
    expect(await call(outbound.save, { record: lead })).toEqual({
      key: "Acme",
      record: lead,
      updatedAt: expect.any(String),
      updatedBy: "run:t",
    });
    expect(await call(outbound.save, { record: { ...lead, stage: "won" } }, "leon")).toMatchObject({
      record: { stage: "won" },
      updatedBy: "leon",
    });
    expect(await call(outbound.get, { key: "Acme" })).toMatchObject({ key: "Acme", record: { stage: "won" } });
    for (const [company, seats] of [
      ["Globex", 3],
      ["Initech", 8],
      ["Umbrella", undefined],
    ] as const) {
      await call(outbound.save, { record: { ...lead, company, ...(seats !== undefined && { seats }) } });
    }
    expect(await keys({})).toEqual(["Acme", "Globex", "Initech", "Umbrella"]);
    expect(await keys({ where: { stage: "researched" } })).toEqual(["Globex", "Initech", "Umbrella"]);
    expect(await keys({ where: { seats: { gt: 3 } } })).toEqual(["Initech"]);
    expect(await keys({ where: { seats: { gte: 3, lte: 8 } } })).toEqual(["Globex", "Initech"]);
    expect(await keys({ order: "seats" })).toEqual(["Globex", "Initech", "Acme", "Umbrella"]);
    expect(await keys({ order: "-seats", limit: 2 })).toEqual(["Initech", "Globex"]);
    expect(await call(outbound.delete, { key: "Globex" })).toEqual({ deleted: true });
    expect(await call(outbound.delete, { key: "Globex" })).toEqual({ deleted: false });
    expect(await call(outbound.get, { key: "constructor" })).toBeNull();
  });

  it('orders text by its bytes, as Postgres under COLLATE "C", and takes any key, __proto__ too', async () => {
    fake.reset();
    for (const company of ["apple", "Banana", "__proto__"]) await call(outbound.save, { record: { ...lead, company } });
    expect(await keys({})).toEqual(["Banana", "__proto__", "apple"]);
    expect(await keys({ where: { company: { gte: "_" } } })).toEqual(["__proto__", "apple"]);
    expect(await call(outbound.get, { key: "__proto__" })).toMatchObject({ key: "__proto__" });
    expect(await call(outbound.delete, { key: "__proto__" })).toEqual({ deleted: true });
  });

  it("takes a value of another type than its field's as missing: it matches no filter and sorts last", async () => {
    fake.reset();
    await call(outbound.save, { record: { ...lead, company: "Globex", seats: 3 } });
    fake.update((state) => {
      state.outbound!.Acme = {
        key: "Acme",
        record: { ...lead, seats: "many" },
        updatedAt: "2026-10-01T00:00:00.000Z",
        updatedBy: "leon",
      };
    });
    expect(await keys({ where: { seats: { gte: 0 } } })).toEqual(["Globex"]);
    expect(await keys({ order: "-seats" })).toEqual(["Globex", "Acme"]);
  });

  it("gives back a record that no longer fits as it is, with its issues", async () => {
    fake.reset();
    fake.update((state) => {
      state.outbound!.Acme = {
        key: "Acme",
        record: { ...lead, stage: "maybe" },
        updatedAt: "2026-10-01T00:00:00.000Z",
        updatedBy: "leon",
      };
    });
    expect(await call(outbound.get, { key: "Acme" })).toEqual({
      key: "Acme",
      record: { ...lead, stage: "maybe" },
      updatedAt: "2026-10-01T00:00:00.000Z",
      updatedBy: "leon",
      issues: [{ path: ["stage"], message: expect.any(String) }],
    });
  });
});

describe("a config's collections", () => {
  const base = { workflows: [], connectors: [], policy: allowAll };

  it("are registered under the vendor data: their operations, a driver and a fake", () => {
    const resolved = resolveConfig({ ...base, workflows: [outboundNext], collections: [outbound, outbound] });
    expect([...resolved.collections]).toEqual([["outbound", outbound]]);
    expect(resolved.ops.get("data.outbound.save")).toBe(outbound.save);
    expect([...resolved.drivers.keys()]).toEqual([
      "data.outbound.get",
      "data.outbound.list",
      "data.outbound.save",
      "data.outbound.delete",
    ]);
    expect([...resolved.fakes.keys()]).toEqual(["data"]);
    expect(resolved.dataStore).toBeDefined();
    // Not a vendor with credentials to set.
    expect(resolved.driversByVendor.size).toBe(0);
    const none = resolveConfig(base);
    expect([none.collections.size, none.ops.size, none.dataStore]).toEqual([0, 0, undefined]);
  });

  it("refuses a workflow using a collection the config does not declare", () => {
    expect(() => resolveConfig({ ...base, workflows: [outboundNext] })).toThrow(
      'Workflow "outbound-next": data.outbound.get is not declared by any connector in `connectors`',
    );
  });

  it("refuses two collections with one name, a connector of the vendor data, and what collection() did not make", () => {
    const again = collection({ name: "outbound", key: "id", fields: { id: "text" } });
    expect(() => resolveConfig({ ...base, collections: [outbound, again] })).toThrow(
      'Two collections are named "outbound"; name each once',
    );
    expect(() => resolveConfig({ ...base, connectors: [defineConnector("data", {})] })).toThrow(
      'A connector in `connectors` is of the vendor "data", which the collections\' operations are of; name it otherwise',
    );
    expect(() => resolveConfig({ ...base, collections: [{ ...outbound, kind: "op" }] as never })).toThrow(
      "`collections` holds something `collection()` did not make",
    );
    expect(() => resolveConfig({ ...base, collections: outbound as never })).toThrow(
      "The config's `collections` must be an array",
    );
  });

  it("are seeded by a scenario's step, which refuses a key field other than the quoted key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-data-feature-"));
    try {
      writeFileSync(
        join(dir, "a.feature"),
        'Feature: A\n  Scenario: B\n    Given data.outbound "Acme" has\n      | company | Globex |\n    When outbound-next runs with\n      | company | Acme |\n',
      );
      const resolved = resolveConfig({ ...base, workflows: [outboundNext], collections: [outbound] });
      const { errors } = await loadScenarios({ ...resolved, scenarios: pathToFileURL(`${dir}/`) });
      expect(errors.map((e) => e.message).join("\n")).toContain(
        'company in data.outbound "Acme" is "Globex": it is the key, "Acme"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are described: name, key, fields, the record's JSON Schema and the operations", () => {
    const { collections, ops } = describeConfig(config);
    expect(collections).toEqual([
      {
        name: "outbound",
        title: "Outbound",
        key: "company",
        fields: outbound.fields,
        record: expect.objectContaining({
          $id: "sanoma:collection/outbound",
          type: "object",
          required: ["company", "contact", "stage", "owner"],
          additionalProperties: false,
        }),
        ops: ["data.outbound.get", "data.outbound.list", "data.outbound.save", "data.outbound.delete"],
      },
    ]);
    expect(collections[0]!.record.properties).toMatchObject({
      stage: { enum: ["researched", "contacted", "replied", "meeting", "won", "lost"] },
      seats: { type: "number" },
    });
    expect(ops.filter((op) => op.vendor === "data").map((op) => [op.id, op.effect])).toEqual([
      ["data.outbound.delete", "write"],
      ["data.outbound.get", "read"],
      ["data.outbound.list", "read"],
      ["data.outbound.save", "write"],
    ]);
  });
});
