import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collection, collectionsFake, recordIssues, recordSchemaOf } from "../src/collection.ts";
import { jsonSchemaOf } from "../src/define.ts";
import {
  converts,
  isBatch,
  isHidden,
  linksIn,
  linkTarget,
  previewRequests,
  reshape,
  reshaped,
  reshapeOf,
} from "../src/shared.ts";
import { describeConfig } from "../src/describe.ts";
import type { ColumnType } from "../src/description.ts";
import { defineConnector, memorySecrets, type Op, resolveConfig } from "../src/index.ts";
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
const batch = (input: unknown) => outbound.saveMany.input.safeParse(input);
/** A batch of `n` deletes. */
const many = (n: number) => ({ deletes: Array.from({ length: n }, (_, i) => ({ key: `k${i}` })) });

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
    for (const kind of [
      "string",
      { type: "object" },
      {},
      { optional: true },
      { type: "text", enum: ["a"] },
      { link: "companies", type: "text" },
      ["text"],
    ]) {
      expect(refused(kind)).toThrow(`collection("leads"): the field "f" is ${JSON.stringify(kind)}; a field is one of`);
    }
    expect(refused({ type: "text", optional: false })).toThrow('the field "f" may only be marked `optional: true`');
    for (const field of [
      { type: "text", hidden: true },
      { type: "text", optional: true, hidden: false },
      { enum: ["a"], hidden: "yes", optional: true },
    ]) {
      expect(refused(field)).toThrow(
        'the field "f" may only be marked `hidden: true`, and only when it is `optional: true`',
      );
    }
    for (const link of ["", "Companies", "crm.companies", 1]) {
      expect(refused({ link })).toThrow('the field "f" links to a collection by its name');
    }
    expect(refused({ enum: [] })).toThrow('the field "f" needs an enum of distinct strings, at least one');
    expect(refused({ enum: ["a", "a"] })).toThrow("needs an enum of distinct strings");
    expect(refused({ enum: ["a", 1] })).toThrow("needs an enum of distinct strings");
    expect(declared({ name: "leads", key: "id", fields: { id: "text", "-f": "text" } })).toThrow(
      'the field "-f" must be named with letters, digits and _, not a digit first',
    );
    expect(declared({ name: "leads", key: "id", fields: {} })).toThrow(`collection("leads"): it needs fields`);
  });

  it("keeps a removed column as a hidden field: optional, its values kept and still read", () => {
    const deals = collection({
      name: "deals",
      key: "company",
      fields: { company: "text", seats: { type: "number", optional: true, hidden: true } },
    });
    expect(deals.fields.seats).toEqual({ type: "number", optional: true, hidden: true });
    expect(deals.save.input.safeParse({ record: { company: "Acme", seats: 12 } }).success).toBe(true);
    expect(deals.save.input.safeParse({ record: { company: "Acme" } }).success).toBe(true);
    expect(recordIssues(deals, { company: "Acme", seats: "12" })).toEqual([
      { path: ["seats"], message: expect.any(String) },
    ]);
    expect([isHidden(deals.fields.seats), isHidden(deals.fields.company), isHidden(undefined)]).toEqual([
      true,
      false,
      false,
    ]);
    // Its schema is marked deprecated, wherever the record is embedded: a form drawn from it leaves it out.
    const embedded = jsonSchemaOf(z.object({ deal: recordSchemaOf(deals) }));
    expect(embedded).toMatchObject({
      properties: {
        deal: {
          properties: { company: { type: "string" }, seats: { type: "number", deprecated: true } },
          required: ["company"],
        },
      },
    });
    expect(jsonSchemaOf(recordSchemaOf(outbound))).not.toHaveProperty(["properties", "seats", "deprecated"]);
  });

  it("takes a free-form field, of anything JSON holds, neither filtered nor sorted by", () => {
    const deals = collection({
      name: "deals",
      key: "company",
      fields: { company: "text", meta: "json", extra: { type: "json", optional: true } },
    });
    const saves = (record: unknown) => deals.save.input.safeParse({ record }).success;
    for (const meta of [{ source: "web", seats: [1, 2] }, [1, "2"], "text", 3, false, null]) {
      expect(saves({ company: "Acme", meta }), JSON.stringify(meta)).toBe(true);
    }
    for (const meta of [undefined, new Date(), Number.NaN, { at: new Date() }, () => 1]) {
      expect(saves({ company: "Acme", meta }), String(meta)).toBe(false);
    }
    expect(saves({ company: "Acme", meta: {}, extra: { a: 1 } })).toBe(true);
    // Its JSON Schema takes anything, so a form enters it as text and the SDK types it `unknown`.
    expect(jsonSchemaOf(recordSchemaOf(deals))).toMatchObject({
      properties: { meta: {}, extra: {} },
      required: ["company", "meta"],
    });
    expect(jsonSchemaOf(recordSchemaOf(deals))).not.toHaveProperty("$defs");
    expect(deals.list.input.safeParse({ where: { meta: "web" } }).success).toBe(false);
    expect(deals.list.input.safeParse({ order: "meta" }).success).toBe(false);
    expect(deals.list.input.safeParse({ order: "-company" }).success).toBe(true);
  });

  it("takes a link: the key of a record of a collection of its folder, said in its schema", () => {
    const orders = collection({
      name: "orders",
      key: "id",
      fields: { id: "text", customer: { link: "customers" }, referrer: { link: "customers", optional: true } },
    });
    const saves = (record: unknown) => orders.save.input.safeParse({ record }).success;
    expect(saves({ id: "o1", customer: "Acme" })).toBe(true);
    expect(saves({ id: "o1", customer: "" })).toBe(false);
    expect(saves({ id: "o1", customer: 1 })).toBe(false);
    expect(jsonSchemaOf(recordSchemaOf(orders))).toMatchObject({
      properties: { customer: { type: "string", description: "The key of a record of customers." } },
    });
    expect(orders.list.input.safeParse({ where: { customer: "Acme" }, order: "customer" }).success).toBe(true);
    expect(linkTarget("orders", "customers")).toBe("customers");
    expect(linkTarget("crm.orders", "customers")).toBe("crm.customers");
  });

  it("makes six operations of the vendor data, each with its effect and target", () => {
    const ops: Op[] = [outbound.get, outbound.list, outbound.count, outbound.save, outbound.saveMany, outbound.delete];
    expect(
      ops.map(({ id, vendor, resource, effect, idempotent }) => ({ id, vendor, resource, effect, idempotent })),
    ).toEqual([
      { id: "data.outbound.get", vendor: "data", resource: "outbound", effect: "read", idempotent: true },
      { id: "data.outbound.list", vendor: "data", resource: "outbound", effect: "read", idempotent: true },
      { id: "data.outbound.count", vendor: "data", resource: "outbound", effect: "read", idempotent: true },
      { id: "data.outbound.save", vendor: "data", resource: "outbound", effect: "write", idempotent: true },
      { id: "data.outbound.saveMany", vendor: "data", resource: "outbound", effect: "write", idempotent: true },
      { id: "data.outbound.delete", vendor: "data", resource: "outbound", effect: "write", idempotent: true },
    ]);
    expect(outbound.get.target!({ key: "Acme" })).toBe("data:outbound/Acme");
    expect(outbound.list.target!({ limit: 100 })).toBe("data:outbound");
    expect(outbound.count.target!({})).toBe("data:outbound");
    expect(outbound.save.target!({ record: lead })).toBe("data:outbound/Acme");
    expect(outbound.saveMany.target!({ records: [{ record: lead }], deletes: [] })).toBe("data:outbound");
    expect(outbound.delete.target!({ key: "Acme" })).toBe("data:outbound/Acme");
    expect(outbound).toMatchObject({ kind: "collection", name: "outbound", key: "company", title: "Outbound" });
    expect(Object.isFrozen(outbound)).toBe(true);
    expect([isBatch(outbound.saveMany), isBatch(outbound.save)]).toEqual([true, false]);
    // The policy is asked about a batch as its entries, once each.
    const byId = new Map([outbound.saveMany, outbound.save, outbound.get].map((op) => [op.id, op]));
    const asked = previewRequests(
      { name: "sync", ops: [outbound.saveMany.id, outbound.save.id, outbound.get.id] },
      byId,
    );
    expect(asked.map((r) => r.action.id)).toEqual([
      "workflow:sync",
      "data.outbound.save",
      "data.outbound.delete",
      "data.outbound.get",
    ]);
  });

  it("takes a batch of 1 to 1000 entries, each key once, and a delete guarded by ifRecord", () => {
    expect(batch({ records: [{ record: lead }] }).data).toEqual({ records: [{ record: lead }], deletes: [] });
    expect(batch({ deletes: [{ key: "Acme" }, { key: "Globex", ifRecord: lead }] }).success).toBe(true);
    expect(batch({ records: [{ record: lead, ifRecord: lead }], deletes: [{ key: "Globex" }] }).success).toBe(true);
    expect(batch({ records: [{ record: lead, ifAbsent: true }] }).success).toBe(true);
    expect(batch(many(1000)).success).toBe(true);
    for (const input of [
      {},
      many(1001),
      { records: [{ record: lead }], deletes: [{ key: "Acme" }] },
      { records: [{ record: lead }, { record: { ...lead, stage: "won" } }] },
      { records: [{ record: lead, ifAbsent: true, ifRecord: lead }] },
      { records: [{ record: { ...lead, stage: "maybe" } }] },
      { deletes: [{ key: "" }] },
    ]) {
      expect(batch(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(outbound.delete.input.safeParse({ key: "Acme", ifRecord: lead }).success).toBe(true);
    expect(outbound.count.input.safeParse({ where: { stage: "won", seats: { gte: 5 } } }).success).toBe(true);
    expect(outbound.count.input.safeParse({ where: { nickname: "Ac" } }).success).toBe(false);
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
    expect(outbound.save.input.safeParse({ record: lead, ifAbsent: true, ifRecord: lead }).success).toBe(false);
    // The comparison may include obsolete fields from a stored record being repaired.
    expect(outbound.save.input.safeParse({ record: lead, ifRecord: { ...lead, obsolete: "old" } }).success).toBe(true);
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

/** That each of `values` converts to `type`. */
const yes = (type: ColumnType, values: unknown[]) => expect(values.filter((v) => !converts(v, type))).toEqual([]);
/** That none of `values` converts to `type`. */
const no = (type: ColumnType, values: unknown[]) => expect(values.filter((v) => converts(v, type))).toEqual([]);

describe("a column change's records", () => {
  it("convert a value that reads as the new type, as a field of it accepts it", () => {
    yes("number", [12, -1.5, "12", " 12 ", "-0.25"]);
    no("number", ["about 40", "1e3", "", "12.", Number.NaN, true, null, {}]);
    yes("boolean", [true, false, "yes", "No", " TRUE "]);
    no("boolean", ["y", 1, "", null]);
    yes("text", ["", "a", 1, false]);
    no("text", [null, {}, []]);
    yes("person", ["leon", 1]);
    no("person", ["", null]);
    yes({ enum: ["won", "1"] }, ["won", 1]);
    no({ enum: ["won"] }, ["Won", "", null]);
    yes({ link: "companies" }, ["Acme", 12]);
    no({ link: "companies" }, ["", null, {}]);
    // Against the keys of the collection it links to, when they are known.
    const keys = new Map([["companies", new Set(["Acme", "12"])]]);
    expect(["Acme", 12, "Globex"].map((v) => converts(v, { link: "companies" }, keys))).toEqual([true, true, false]);
    expect(converts("Globex", { link: "people" }, keys)).toBe(true);
    yes("json", [null, "", {}, [1], 3, "text"]);
    // A date: what a `date` field's schema takes, no more, no less.
    const field = collection({ name: "days", key: "id", fields: { id: "text", on: "date" } });
    const dates = ["2026-11-10", "2024-02-29", "0000-02-29", "2026-11-10T09:30:00Z", "2026-11-10T09:30:00.123+02:00"];
    const notDates = [
      "2026-02-29",
      "2026-02-30T00:00:00Z",
      "2026-13-01",
      "2026-11-10T09:30Z",
      "2026-11-10T09:30:00",
      "2026-11-10T09:30:00+0200",
      "2026-11-10T24:00:00Z",
      "2026-11-10 09:30:00Z",
      "20261110",
      20261110,
    ];
    for (const on of [...dates, ...notDates]) {
      expect([on, converts(on, "date")]).toEqual([on, field.save.input.safeParse({ record: { id: "d", on } }).success]);
    }
    yes("date", dates);
  });

  it("bring a record along each change, the very record when nothing changes, and do it once", () => {
    const record = {
      company: "Acme",
      seats: "12",
      touched: "2026-01-02",
      notes: "",
      extra: { region: "EU", size: "big" },
    };
    expect(reshaped(record, { kind: "rename", from: "touched", to: "contacted" })).toEqual({
      record: { company: "Acme", seats: "12", notes: "", extra: record.extra, contacted: "2026-01-02" },
      did: "moved",
    });
    // Nothing to move, or the new name already holds a value: left alone.
    for (const change of [
      { kind: "rename", from: "gone", to: "here" },
      { kind: "rename", from: "touched", to: "company" },
    ] as const) {
      expect(reshaped(record, change).record).toBe(record);
    }
    expect(reshaped(record, { kind: "retype", field: "seats", to: "number" })).toEqual({
      record: { ...record, seats: 12 },
      did: "converted",
    });
    expect(reshaped({ ...record, seats: 12 }, { kind: "retype", field: "seats", to: "number" })).toEqual({
      record: { ...record, seats: 12 },
    });
    expect(reshaped(record, { kind: "retype", field: "missing", to: "number" }).record).toBe(record);
    // One that cannot convert is kept by default, or cleared; an empty one is no value: dropped.
    const big = { kind: "retype", field: "extra", to: "number" } as const;
    expect(reshaped(record, big)).toEqual({ record, did: "kept" });
    expect(reshaped(record, { ...big, decision: "keep" }).record).toBe(record);
    const { extra: _, ...cleared } = record;
    expect(reshaped(record, { ...big, decision: "clear" })).toEqual({ record: cleared, did: "cleared" });
    const { notes: __, ...noNotes } = record;
    expect(reshaped(record, { kind: "retype", field: "notes", to: "number" })).toEqual({ record: noNotes });
    // A key of a free-form field to a field of its own, by another name; only where that field is empty.
    expect(reshaped(record, { kind: "convert", field: "extra", key: "region", to: "area", type: "text" })).toEqual({
      record: { ...record, extra: { size: "big" }, area: "EU" },
      did: "converted",
    });
    const size = { kind: "convert", field: "extra", key: "size", to: "size", type: "number" } as const;
    expect(reshaped(record, size)).toEqual({ record, did: "kept" });
    expect(reshaped(record, { ...size, decision: "clear" })).toEqual({
      record: { ...record, extra: { region: "EU" } },
      did: "cleared",
    });
    expect(reshaped({ ...record, region: "US" }, { ...size, key: "region", to: "region" }).did).toBeUndefined();
    // A retype to a link: a key the collection it links to has converts, another is kept or cleared.
    const linked = new Map([["companies", new Set(["Acme"])]]);
    const toLink = { kind: "retype", field: "company", to: { link: "companies" } } as const;
    expect(reshaped(record, toLink, linked)).toEqual({ record });
    expect(reshaped({ ...record, company: "Globex" }, toLink, linked)).toEqual({
      record: { ...record, company: "Globex" },
      did: "kept",
    });
    expect(reshaped({ ...record, company: "Globex" }, { ...toLink, decision: "clear" }, linked).did).toBe("cleared");
    // Anything to free-form: every value converts, as it is.
    expect(reshaped(record, { kind: "retype", field: "extra", to: "json" }).record).toBe(record);
    expect(reshaped(record, { ...size, field: "company" }).record).toBe(record);
    // A removed field's value deleted, counted as cleared when it held one; nothing to delete, left alone.
    const { seats: ___, ...noSeats } = record;
    expect(reshaped(record, { kind: "remove", field: "seats" })).toEqual({ record: noSeats, did: "cleared" });
    expect(reshaped(record, { kind: "remove", field: "notes" })).toEqual({ record: noNotes });
    expect(reshaped(noSeats, { kind: "remove", field: "seats" }).record).toBe(noSeats);
  });

  it("count what became of the records, and plan the call from the changes that move values", () => {
    const records = [{ seats: "12", a: 1 }, { seats: "about 40" }, { b: 2 }, { seats: "" }];
    const changes = [
      { kind: "rename", from: "a", to: "b" },
      { kind: "retype", field: "seats", to: "number", decision: "clear" },
    ] as const;
    const { changed, counts } = reshape(records, changes);
    expect(counts).toEqual({ rows: 4, changed: 3, converted: 1, cleared: 1, kept: 0 });
    expect([...changed]).toEqual([
      [0, { seats: 12, b: 1 }],
      [1, {}],
      [3, {}],
    ]);
    const changedAgain = reshape([...changed.values()], changes).counts.changed;
    expect(changedAgain).toBe(0);
    // The collections a retype or a conversion links to, each once: whose keys the driver reads.
    expect(
      linksIn([
        { kind: "retype", field: "a", to: { link: "companies" } },
        { kind: "convert", field: "meta", key: "b", to: "b", type: { link: "companies" } },
        { kind: "convert", field: "meta", key: "c", to: "c", type: { link: "people" } },
        { kind: "retype", field: "d", to: "text" },
      ]),
    ).toEqual(["companies", "people"]);

    const wontConvert = { count: 0, sample: [] };
    expect(
      reshapeOf({
        collection: "deals",
        rows: 4,
        changes: [
          { kind: "add", field: "region", type: "text", required: false, empty: 4 },
          { kind: "rename", from: "a", to: "b" },
          { kind: "retype", field: "seats", from: "text", to: "number", wontConvert, decision: "clear" },
          { kind: "convert", field: "extra", key: "size", to: "size", type: "number", filled: 2, wontConvert },
          { kind: "hide", field: "notes", filled: 2 },
          { kind: "show", field: "owner", filled: 1 },
          { kind: "remove", field: "legacy", filled: 3 },
        ],
      }),
    ).toEqual({
      collection: "deals",
      changes: [
        { kind: "rename", from: "a", to: "b" },
        { kind: "retype", field: "seats", to: "number", decision: "clear" },
        { kind: "convert", field: "extra", key: "size", to: "size", type: "number" },
        { kind: "remove", field: "legacy" },
      ],
    });
    expect(reshapeOf(undefined)).toBeUndefined();
    expect(
      reshapeOf({ collection: "deals", rows: 1, changes: [{ kind: "hide", field: "notes", filled: 1 }] }),
    ).toBeUndefined();
  });
});

describe("the collections' fake", () => {
  const fake = collectionsFake([outbound]);
  let n = 0;
  const call = async (op: Op, input: unknown, by?: string, attempt = 1) => {
    const fn = fake.driver.ops[`${op.resource}.${op.name}`]!;
    const context = { idempotencyKey: `t:${n++}`, runId: "t", opId: op.id, attempt, secrets: memorySecrets() };
    return op.output.parse(await fn(op.input.parse(input), by === undefined ? context : { ...context, by }));
  };
  const keys = async (query: unknown) => ((await call(outbound.list, query)) as { key: string }[]).map((s) => s.key);

  it("recovers an identical claim but refuses another actor or changed record", async () => {
    fake.reset();
    const first = await call(outbound.save, { record: { ...lead, seats: undefined }, ifAbsent: true }, "ada");
    expect(await call(outbound.save, { record: lead, ifAbsent: true }, "ada")).toEqual(first);
    await expect(call(outbound.save, { record: lead, ifAbsent: true }, "bo")).rejects.toMatchObject({
      retryable: false,
      status: 409,
      vendorCode: "record_exists",
      current: first,
    });
    const advanced = await call(outbound.save, { record: { ...lead, stage: "won" } }, "ada");
    await expect(call(outbound.save, { record: lead, ifAbsent: true }, "ada")).rejects.toMatchObject({
      vendorCode: "record_exists",
    });
    expect(await call(outbound.get, { key: "Acme" })).toEqual(advanced);
  });

  it("compares stored JSON for transitions, preserves retry receipts and refuses stale writers", async () => {
    fake.reset();
    await expect(call(outbound.save, { record: lead, ifRecord: lead }, "ada")).rejects.toMatchObject({
      vendorCode: "record_changed",
      current: null,
    });
    await call(outbound.save, { record: { ...lead, seats: undefined } }, "owner");
    const record = { ...lead, stage: "won" };
    const transition = await call(outbound.save, { record, ifRecord: lead }, "ada");
    expect(await call(outbound.save, { record, ifRecord: lead }, "ada")).toEqual(transition);
    // The refusal says what the record is now, for the caller to settle the conflict without another read.
    await expect(call(outbound.save, { record, ifRecord: lead }, "bo")).rejects.toMatchObject({
      status: 409,
      retryable: false,
      vendorCode: "record_changed",
      current: transition,
    });
    const later = await call(outbound.save, { record: { ...record, seats: 3 }, ifRecord: record }, "owner");
    await expect(call(outbound.save, { record, ifRecord: lead }, "ada")).rejects.toMatchObject({
      vendorCode: "record_changed",
      current: later,
    });
    expect(await call(outbound.get, { key: "Acme" })).toEqual(later);
  });

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
    expect(await call(outbound.delete, { key: "Globex" })).toEqual({ key: "Globex", deleted: true });
    expect(await call(outbound.delete, { key: "Globex" })).toEqual({ key: "Globex", deleted: false });
    expect(await call(outbound.get, { key: "constructor" })).toBeNull();
  });

  it('orders text by its bytes, as Postgres under COLLATE "C", and takes any key, __proto__ too', async () => {
    fake.reset();
    for (const company of ["apple", "Banana", "__proto__"]) await call(outbound.save, { record: { ...lead, company } });
    expect(await keys({})).toEqual(["Banana", "__proto__", "apple"]);
    expect(await keys({ where: { company: { gte: "_" } } })).toEqual(["__proto__", "apple"]);
    expect(await call(outbound.get, { key: "__proto__" })).toMatchObject({ key: "__proto__" });
    expect(await call(outbound.delete, { key: "__proto__" })).toEqual({ key: "__proto__", deleted: true });
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

  it("saves and deletes a batch all or none, answering in order, and counts, as the driver on Postgres does", async () => {
    fake.reset();
    const globex = { ...lead, company: "Globex", seats: 3 };
    const initech = { ...lead, company: "Initech", stage: "won" };
    for (const record of [lead, globex, initech]) await call(outbound.save, { record }, "leon");
    expect(await call(outbound.count, {})).toEqual({ count: 3 });
    expect(await call(outbound.count, { where: { stage: "researched", seats: { gte: 3 } } })).toEqual({ count: 1 });
    const results = (await call(
      outbound.saveMany,
      {
        records: [
          { record: { ...lead, stage: "contacted" }, ifRecord: lead },
          { record: { ...lead, company: "Umbrella" } },
        ],
        deletes: [{ key: "Globex", ifRecord: globex }, { key: "Nobody" }],
      },
      "ada",
    )) as Record<string, unknown>[];
    expect(results).toEqual([
      { key: "Acme", record: { ...lead, stage: "contacted" }, updatedAt: expect.any(String), updatedBy: "ada" },
      { key: "Umbrella", record: { ...lead, company: "Umbrella" }, updatedAt: expect.any(String), updatedBy: "ada" },
      { key: "Globex", deleted: true },
      { key: "Nobody", deleted: false },
    ]);
    expect(await keys({})).toEqual(["Acme", "Initech", "Umbrella"]);
    // One conflict refuses the whole batch, every conflict listed with the record as it stands, and nothing changes.
    const current = await call(outbound.get, { key: "Acme" });
    await expect(
      call(
        outbound.saveMany,
        {
          records: [
            { record: { ...lead, company: "Wayne" } },
            { record: { ...lead, stage: "won" }, ifRecord: lead },
            { record: { ...lead, company: "Umbrella", stage: "won" }, ifAbsent: true },
          ],
          deletes: [
            { key: "Initech", ifRecord: lead },
            { key: "Gone", ifRecord: lead },
          ],
        },
        "ada",
      ),
    ).rejects.toMatchObject({
      status: 409,
      retryable: false,
      vendorCode: "record_changed",
      conflicts: [
        { key: "Acme", current },
        { key: "Umbrella", current: await call(outbound.get, { key: "Umbrella" }) },
        { key: "Initech", current: await call(outbound.get, { key: "Initech" }) },
        { key: "Gone", current: null },
      ],
    });
    expect(await keys({})).toEqual(["Acme", "Initech", "Umbrella"]);
    expect(await call(outbound.get, { key: "Acme" })).toEqual(current);
    // A delete guarded by ifRecord refuses a changed or missing record as a save does.
    await expect(call(outbound.delete, { key: "Acme", ifRecord: lead })).rejects.toMatchObject({
      vendorCode: "record_changed",
      current,
    });
    await expect(call(outbound.delete, { key: "Gone", ifRecord: lead })).rejects.toMatchObject({ current: null });
    // A retry finding no record deleted it the first time; one finding another record did not.
    expect(await call(outbound.delete, { key: "Gone", ifRecord: lead }, undefined, 2)).toEqual({
      key: "Gone",
      deleted: true,
    });
    await expect(call(outbound.delete, { key: "Acme", ifRecord: lead }, undefined, 2)).rejects.toMatchObject({
      current,
    });
    expect(await call(outbound.delete, { key: "Acme", ifRecord: { ...lead, stage: "contacted" } })).toEqual({
      key: "Acme",
      deleted: true,
    });
    expect(await call(outbound.count, {})).toEqual({ count: 2 });
  });

  it("saves a link only to a record that is there, and reads one to a record deleted since as an issue", async () => {
    const customers = collection({ name: "customers", key: "id", fields: { id: "text" } });
    const orders = collection({
      name: "orders",
      key: "id",
      fields: { id: "text", customer: { link: "customers" }, meta: { type: "json", optional: true } },
    });
    const linking = collectionsFake([customers, orders]);
    const run = async (op: Op, input: unknown) => {
      const fn = linking.driver.ops[`${op.resource}.${op.name}`]!;
      const context = { idempotencyKey: `l:${n++}`, runId: "l", opId: op.id, attempt: 1, secrets: memorySecrets() };
      return op.output.parse(await fn(op.input.parse(input), context));
    };
    const order = { id: "o1", customer: "acme", meta: { source: "web" } };
    await expect(run(orders.save, { record: order })).rejects.toMatchObject({
      status: 422,
      retryable: false,
      vendorCode: "link_missing",
      message: 'customer: customers has no record "acme"',
      missing: [{ key: "o1", field: "customer", value: "acme", target: "customers" }],
    });
    expect(await run(orders.get, { key: "o1" })).toBeNull();
    // A batch checks after every entry: a record it saves may be one another links to.
    await run(orders.saveMany, { records: [{ record: order }] }).catch(() => undefined);
    expect(await run(orders.count, {})).toEqual({ count: 0 });
    await run(customers.save, { record: { id: "acme" } });
    expect(await run(orders.save, { record: order })).toMatchObject({ key: "o1", record: order });
    expect(await run(orders.get, { key: "o1" })).not.toHaveProperty("issues");
    // Deleted since: read as it is, the link an issue to fix; saved again, refused until it links elsewhere.
    await run(customers.delete, { key: "acme" });
    const issues = [{ path: ["customer"], message: 'customers has no record "acme"' }];
    expect(await run(orders.get, { key: "o1" })).toMatchObject({ record: order, issues });
    expect(await run(orders.list, {})).toMatchObject([{ key: "o1", issues }]);
    await expect(run(orders.save, { record: { ...order, meta: null } })).rejects.toMatchObject({
      vendorCode: "link_missing",
    });
    expect(await run(orders.get, { key: "o1" })).toMatchObject({ record: order });
    await run(customers.save, { record: { id: "globex" } });
    expect(await run(orders.save, { record: { ...order, customer: "globex" } })).not.toHaveProperty("issues");
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
  const base = { workflows: [], connectors: [] };

  it("are registered under the vendor data: their operations, a driver and a fake", () => {
    const resolved = resolveConfig({ ...base, workflows: [outboundNext], collections: [outbound, outbound] });
    expect([...resolved.collections]).toEqual([["outbound", outbound]]);
    expect(resolved.ops.get("data.outbound.save")).toBe(outbound.save);
    expect([...resolved.drivers.keys()]).toEqual([
      // The built-in placeholder for a change's operations, the listing of apps and the runtime's own, in every config.
      "sanoma.change.open",
      "sanoma.change.review",
      "sanoma.change.merge",
      "sanoma.change.close",
      "sanoma.records.reshape",
      "sanoma.connection.test",
      "sanoma.connection.refresh",
      "sanoma.connection.revoke",
      "sanoma.connection.prepare",
      "sanoma.connection.configure",
      "sanoma.connection.activate",
      "sanoma.connection.authorize",
      "sanoma.connection.exchange",
      "sanoma.connection.disconnect",
      "sanoma.connection.bind",
      "sanoma.connection.create",
      "sanoma.apps.list",
      "sanoma.run.inspect",
      "sanoma.secretStore.prepare",
      "sanoma.identity.enroll",
      "sanoma.identity.retire",
      "sanoma.identity.revoke",
      "sanoma.secret.generate",
      "sanoma.secret.delete",
      "sanoma.invite.mint",
      "sanoma.token.mint",
      "sanoma.token.revoke",
      "sanoma.token.handoff",
      "sanoma.storeMigration.plan",
      "sanoma.storeMigration.prepare",
      "sanoma.storeMigration.transfer",
      "sanoma.storeMigration.verify",
      "sanoma.storeMigration.cutover",
      "sanoma.storeMigration.retire",
      "sanoma.storeMigration.cancel",
      "data.outbound.get",
      "data.outbound.list",
      "data.outbound.count",
      "data.outbound.save",
      "data.outbound.saveMany",
      "data.outbound.delete",
    ]);
    expect([...resolved.fakes.keys()]).toEqual(["data"]);
    expect(resolved.dataStore).toBeDefined();
    // Not a vendor with credentials to set.
    expect(resolved.driversByVendor.size).toBe(0);
    const none = resolveConfig(base);
    expect([none.collections.size, none.ops.has("data.outbound.get"), none.dataStore]).toEqual([0, false, undefined]);
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

  it("refuses a link to a collection the config does not have: one deleted or renamed that another links to", () => {
    const orders = collection({ name: "orders", key: "id", fields: { id: "text", customer: { link: "customers" } } });
    const customers = collection({ name: "customers", key: "id", fields: { id: "text" } });
    expect(() => resolveConfig({ ...base, collections: [orders] })).toThrow(
      'The collection "orders" links its field "customer" to "customers", which no collection is named: declare it, or change the link',
    );
    expect(resolveConfig({ ...base, collections: [orders, customers] }).collections.size).toBe(2);
  });

  it("are seeded by a scenario's step, which refuses a key field other than the quoted key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanoma-data-feature-"));
    try {
      mkdirSync(join(dir, "scenarios"));
      writeFileSync(
        join(dir, "scenarios/a.feature"),
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
        ops: [
          "data.outbound.get",
          "data.outbound.list",
          "data.outbound.count",
          "data.outbound.save",
          "data.outbound.saveMany",
          "data.outbound.delete",
        ],
        declared: {
          id: "resources/data.ts#outbound",
          file: "resources/data.ts",
          name: "outbound",
          at: { file: "resources/data.ts", export: "outbound" },
        },
      },
    ]);
    expect(collections[0]!.record.properties).toMatchObject({
      stage: { enum: ["researched", "contacted", "replied", "meeting", "won", "lost"] },
      seats: { type: "number" },
      // A person is marked, so a form draws a person's input.
      owner: { type: "string", minLength: 1, format: "person" },
    });
    expect(ops.filter((op) => op.vendor === "data").map((op) => [op.id, op.effect])).toEqual([
      ["data.outbound.count", "read"],
      ["data.outbound.delete", "write"],
      ["data.outbound.get", "read"],
      ["data.outbound.list", "read"],
      ["data.outbound.save", "write"],
      ["data.outbound.saveMany", "write"],
    ]);
  });

  it("pass what `sanoma check` holds them to: the loader, and the workflow importing them", () => {
    const { problems, resources, workflows } = describeConfig(config);
    expect(problems).toEqual([]);
    expect(resources).toEqual([]);
    expect(workflows.flatMap((wf) => wf.problems)).toEqual([]);
  });
});
