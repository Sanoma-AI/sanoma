import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import { FIELD_NAME, FIELD_TYPES, isRecord, type Saved } from "@sanoma-ai/workflows/shared";
import { z } from "zod";

// A change to a collection's columns, as a person proposes it from the grid (`ColumnChange`) and
// reviews it on its change's page (`TableChangePlan`, the runtime session's provisional shape,
// #630). Until the runtime plans a table change itself (its SQL, its rows counted in the table),
// the app drafts the plan here from the rows it read and the declaration: `planOf` is that one
// seam, which the runtime's plan replaces.

/** A new field's name, as `collection()` takes it. */
const NAME = z.string().regex(FIELD_NAME, "Letters, digits and _, not a digit first");

/** A column's type: the runtime's field types, a choice, a link to another collection, or free-form JSON. */
const FieldTypeSchema = z.union([
  z.enum([...FIELD_TYPES, "json"]),
  z.strictObject({
    enum: z
      .array(z.string().trim().min(1))
      .min(1, "Give it a choice")
      .refine((values) => new Set(values).size === values.length, "Each choice once"),
  }),
  z.strictObject({ link: z.string().min(1) }),
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

const COUNT = z.number().int();

/** The rows a change cannot convert: how many, and at most `SAMPLE` of them by key. */
const WontConvertSchema = z.object({
  count: COUNT,
  sample: z.array(z.object({ key: z.string(), value: z.unknown() })),
});
type WontConvert = z.infer<typeof WontConvertSchema>;

/** What becomes of the rows a retype cannot convert: kept as text, cleared, or the change called off. */
const RetypeDecisionSchema = z.enum(["keep-text", "clear-unconvertible", "cancel"]);
export type RetypeDecision = z.infer<typeof RetypeDecisionSchema>;

/** One change to a table, with the rows it touches counted (`empty`, `filled`, `unmatched`, `wontConvert.count`). */
const TableChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), field: z.string(), type: FieldTypeSchema, required: z.boolean(), empty: COUNT }),
  z.object({ kind: z.literal("rename"), from: z.string(), to: z.string() }),
  z.object({
    kind: z.literal("retype"),
    field: z.string(),
    from: FieldTypeSchema,
    to: FieldTypeSchema,
    wontConvert: WontConvertSchema,
    decision: RetypeDecisionSchema.optional(),
  }),
  z.object({ kind: z.literal("require"), field: z.string(), empty: COUNT }),
  z.object({ kind: z.literal("delete"), field: z.string(), filled: COUNT }),
  z.object({ kind: z.literal("link"), field: z.string(), to: z.string(), unmatched: COUNT }),
  z.object({
    kind: z.literal("convert"),
    field: z.string(),
    key: z.string(),
    type: FieldTypeSchema,
    wontConvert: WontConvertSchema,
  }),
]);
export type TableChange = z.infer<typeof TableChangeSchema>;

/**
 * A table change as the person reviews it: what the declarations before and after differ in, the
 * records in the table now (`rows`), "Show SQL" (`sql`, the statements in order, informational,
 * empty until the runtime plans the change), and `blocked` while a change has rows that won't
 * convert and no decision. A change's page reads the plan it carries through this, as anything
 * else starting a `patch` could have written it.
 */
export const TableChangePlan = z.object({
  collection: z.string(),
  changes: z.array(TableChangeSchema).min(1),
  rows: COUNT,
  sql: z.array(z.string()),
  blocked: z.boolean(),
});
export type TableChangePlan = z.infer<typeof TableChangePlan>;

/** How many of the rows that won't convert a plan names. */
const SAMPLE = 20;

/** Why a link or a free-form column cannot be proposed yet. */
export const NOT_YET = "Links and free-form columns arrive with real tables";

/** What the review says in place of the SQL until the runtime plans a table change. */
export const NO_SQL = "SQL is shown once the table change lands";

/**
 * What a draft plan (no SQL) changes, said beside it: only the data file, so the records keep
 * what they hold until the runtime plans and applies a table change.
 */
export const FILE_ONLY =
  "Until real tables land, this changes resources/data.ts only: each record keeps what it holds, and one the new declaration no longer fits shows as needs fixing.";

/**
 * Whether `FILE_ONLY` goes beside a plan: a draft (no SQL) whose change touches what the records
 * hold, anything but an optional new column.
 */
export const fileOnly = (plan: TableChangePlan) =>
  plan.sql.length === 0 && plan.rows > 0 && plan.changes.some((change) => change.kind !== "add" || change.required);

/** A change to a collection's columns, as the grid proposes it: a `TableChange` before its rows are counted. */
export const ColumnChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), field: NAME, type: FieldTypeSchema, required: z.boolean() }),
  z.strictObject({ kind: z.literal("rename"), from: z.string().min(1), to: NAME }),
  z.strictObject({ kind: z.literal("retype"), field: z.string().min(1), to: FieldTypeSchema }),
  z.strictObject({ kind: z.literal("require"), field: z.string().min(1) }),
  z.strictObject({ kind: z.literal("delete"), field: z.string().min(1) }),
  z.strictObject({ kind: z.literal("link"), field: z.string().min(1), to: z.string().min(1) }),
  z.strictObject({ kind: z.literal("convert"), field: z.string().min(1), key: NAME, type: FieldTypeSchema }),
]);
export type ColumnChange = z.infer<typeof ColumnChange>;

/** A field as `collection()` declares it. */
type Field = CollectionEntry["fields"][string];

/** A declared field's type. */
export const typeOf = (field: Field): FieldType =>
  typeof field === "string" ? field : "enum" in field ? { enum: [...field.enum] } : field.type;

/** Whether a declared field is required: not marked `optional`. */
export const requiredOf = (field: Field): boolean => typeof field === "string" || field.optional !== true;

/** A field's declaration of `type`, required or `optional: true`, as the data file writes it. */
function fieldOf(type: FieldType, required: boolean): string | Record<string, unknown> {
  if (typeof type === "string") return required ? type : { type, optional: true };
  return required ? type : { ...type, optional: true };
}

/** Whether the runtime takes a field of `type` today: a link and free-form arrive with real tables. */
export const takenToday = (type: FieldType): boolean =>
  type !== "json" && !(typeof type === "object" && "link" in type);

const filled = (value: unknown) => value !== undefined && value !== null && value !== "";
const NUMBER = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Whether `value`, filled, reads as `type`: what a retype keeps. */
function converts(value: unknown, type: FieldType): boolean {
  if (typeof type === "object") {
    return "enum" in type ? type.enum.includes(String(value)) : typeof value === "string";
  }
  switch (type) {
    case "number":
      return typeof value === "number" || (typeof value === "string" && NUMBER.test(value.trim()));
    case "boolean":
      return typeof value === "boolean" || ["true", "false", "yes", "no"].includes(String(value).toLowerCase());
    case "date":
      return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "text":
    case "person":
      return typeof value !== "object";
    case "json":
      return true;
  }
}

/** The filled values among `values` that do not read as `type`. */
function wontConvert(values: { key: string; value: unknown }[], type: FieldType): WontConvert {
  const wont = values.filter(({ value }) => filled(value) && !converts(value, type));
  return { count: wont.length, sample: wont.slice(0, SAMPLE) };
}

/** The value under `key` of a free-form field's object; none for anything else. */
const valueAt = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** Each key of the objects in a free-form field, with how many of the rows have it, the most first. */
export function keysIn(rows: readonly Saved[], field: string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { record } of rows) {
    const value = record[field];
    if (!isRecord(value)) continue;
    for (const key of Object.keys(value)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count })).toSorted((a, b) => b.count - a.count);
}

/**
 * Why `change` cannot be proposed on `collection` as declared: a field it does not have, a name
 * it has already, the key (which names each record), a type the runtime does not take yet; none
 * when it can.
 */
export function problemOf({ key, fields }: Pick<CollectionEntry, "key" | "fields">, change: ColumnChange) {
  const named = "field" in change ? change.field : change.from;
  if (change.kind !== "add" && !Object.hasOwn(fields, named)) return `${named} is not a field of this collection`;
  const taken = change.kind === "add" ? change.field : change.kind === "rename" ? change.to : undefined;
  if (taken !== undefined && Object.hasOwn(fields, taken)) return `${taken} is a field already`;
  if (change.kind === "convert" && Object.hasOwn(fields, change.key)) return `${change.key} is a field already`;
  if (change.kind !== "add" && change.kind !== "convert" && named === key) {
    return `${key} is the key, which names each record: it stays as it is`;
  }
  const type = "type" in change ? change.type : change.kind === "retype" ? change.to : undefined;
  if (change.kind === "link" || (type !== undefined && !takenToday(type))) {
    return NOT_YET;
  }
  if (change.kind === "convert" && typeOf(fields[change.field]!) !== "json") return `${change.field} is not free-form`;
  return undefined;
}

/**
 * The draft plan of `change` to `collection`, over `rows`, the records read for it: each row's
 * value counted, a retype's or a conversion's values that do not read as the new type sampled,
 * no SQL. The runtime's own plan replaces this one (`NO_SQL`).
 */
export function planOf(collection: CollectionEntry, rows: readonly Saved[], change: ColumnChange): TableChangePlan {
  const values = (field: string) => rows.map(({ key, record }) => ({ key, value: record[field] }));
  const count = (field: string) => values(field).filter(({ value }) => filled(value)).length;
  let planned: TableChange;
  switch (change.kind) {
    case "add":
      planned = { ...change, empty: rows.length };
      break;
    case "rename":
      planned = change;
      break;
    case "retype": {
      const from = typeOf(collection.fields[change.field]!);
      planned = { ...change, from, wontConvert: wontConvert(values(change.field), change.to) };
      break;
    }
    case "require":
      planned = { ...change, empty: rows.length - count(change.field) };
      break;
    case "delete":
      planned = { ...change, filled: count(change.field) };
      break;
    case "link":
      // Every filled value, until the runtime matches them against the other table's keys.
      planned = { ...change, unmatched: count(change.field) };
      break;
    case "convert": {
      const inner = rows.map(({ key, record }) => ({ key, value: valueAt(record[change.field], change.key) }));
      planned = { ...change, wontConvert: wontConvert(inner, change.type) };
      break;
    }
  }
  const blocked = "wontConvert" in planned && planned.wontConvert.count > 0;
  return { collection: collection.name, changes: [planned], rows: rows.length, sql: [], blocked };
}

/** What `patch` takes: the fields to set, and those to rename or remove. */
interface DeclarationEdit {
  fields: Record<string, ReturnType<typeof fieldOf>>;
  rename: Record<string, string | null>;
}
const set = (field: string, type: FieldType, required: boolean): DeclarationEdit => ({
  fields: { [`fields.${field}`]: fieldOf(type, required) },
  rename: {},
});
const rename = (field: string, to: string | null): DeclarationEdit => ({
  fields: {},
  rename: { [`fields.${field}`]: to },
});

/**
 * What a change sets in the collection's declaration, by path as `setFields` takes them
 * (`fields`), and renames or removes (`rename`, as `renameFields` takes them), from its fields
 * as declared (`fields`, main's).
 */
export function declarationEdit(fields: CollectionEntry["fields"], change: ColumnChange | TableChange) {
  const declared = "field" in change ? fields[change.field] : undefined;
  switch (change.kind) {
    case "add":
      return set(change.field, change.type, change.required);
    case "rename":
      return rename(change.from, change.to);
    case "retype":
      return set(change.field, change.to, requiredOf(declared!));
    case "require":
      return set(change.field, typeOf(declared!), true);
    case "delete":
      return rename(change.field, null);
    case "link":
      return set(change.field, { link: change.to }, requiredOf(declared!));
    case "convert":
      return set(change.key, change.type, false);
  }
}

/** A type in words: "text", "a number", "a choice: High, Normal or Low". */
export function typeWords(type: FieldType): string {
  if (typeof type === "object") {
    return "enum" in type ? `a choice: ${OR.format(type.enum)}` : `a link to ${type.link}`;
  }
  return TYPE_WORDS[type];
}
const TYPE_WORDS = {
  text: "text",
  number: "a number",
  boolean: "yes / no",
  date: "a date",
  person: "a person",
  json: "free-form",
} as const;
const OR = new Intl.ListFormat("en", { type: "disjunction" });

/** A plan's records as a sentence's subject: "No records", "The record", "All 12 records". */
export const allRecords = ({ rows }: TableChangePlan) =>
  rows === 0 ? "No records" : rows === 1 ? "The record" : `All ${rows} records`;

/**
 * A rename's records, said: until the runtime plans the table change (no SQL), each keeps its
 * value under the old name, so the new one shows empty.
 */
export const renamed = (plan: TableChangePlan, { from, to }: { from: string; to: string }) =>
  plan.sql.length || plan.rows === 0
    ? `${allRecords(plan)} keep their values.`
    : `${allRecords(plan)} keep their values under ${from} until the table change lands, so ${to} shows empty in them.`;

/**
 * How many records, in words: `lib/utils.ts`'s `plural`, which this file cannot import, since
 * `api.ts` brings it into the package's build, where `#/` does not resolve.
 */
const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;

/** What a plan's change will do, in a sentence: the New column panel's "What will happen". */
export function happens(plan: TableChangePlan): string {
  const [change] = plan.changes;
  const all = allRecords(plan);
  switch (change?.kind) {
    case "add":
      return change.required && plan.rows > 0
        ? `${plan.collection} gains a required ${change.field} column. ${all} show it empty, and each needs a value before it saves again.`
        : `${plan.collection} gains a ${change.field} column. ${all} show it empty, and nothing else changes.`;
    case "rename":
      return `${change.from} is called ${change.to} from now on. ${renamed(plan, change)}`;
    case "retype":
    case "convert": {
      const to = change.kind === "retype" ? change.to : change.type;
      const what = change.kind === "retype" ? change.field : `${change.field}'s ${change.key}`;
      const wont = change.wontConvert.count;
      return wont === 0
        ? `${what} becomes ${typeWords(to)}. Every value converts.`
        : `${what} becomes ${typeWords(to)}. ${records(wont)} can't convert, and the review asks what to do with them.`;
    }
    case "require":
      return change.empty === 0
        ? `${change.field} is required from now on. Every record has it.`
        : `${change.field} is required from now on. ${records(change.empty)} have it empty, and need one before they save again.`;
    case "delete":
      return change.filled === 0
        ? `${change.field} leaves the grid and the forms. No record has a value in it.`
        : `${change.field} leaves the grid and the forms. Its values in ${records(change.filled)} are kept.`;
    case "link":
      return `${change.field} links to ${change.to}.`;
    case undefined:
      return "Nothing changes.";
  }
}

/** A declaration's value as the data file writes it, on one line. */
function literal(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{ ${Object.entries(value)
      .map(([k, v]) => `${k}: ${literal(v)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

/**
 * The lines of the collection's `fields` a plan's changes remove (`-`) and add (`+`), from its
 * fields as declared on main (`fields`): the review's diff of the data file.
 */
export function diffLines(fields: CollectionEntry["fields"], changes: readonly TableChange[]) {
  const lines: { sign: "+" | "-"; text: string }[] = [];
  const line = (sign: "+" | "-", field: string, value: unknown) =>
    lines.push({ sign, text: `${field}: ${value === undefined ? "…" : literal(value)},` });
  for (const change of changes) {
    const name = change.kind === "rename" ? change.from : change.field;
    const declared = fields[name];
    if (change.kind !== "add" && change.kind !== "convert") {
      line("-", name, declared);
      // No longer declared on main (merged since): the change by name alone.
      if (declared === undefined) {
        if (change.kind === "rename") line("+", change.to, undefined);
        else if (change.kind !== "delete") line("+", name, undefined);
        continue;
      }
    }
    const edit = declarationEdit(fields, change);
    for (const [path, value] of Object.entries(edit.fields)) line("+", path.slice("fields.".length), value);
    for (const to of Object.values(edit.rename)) if (to !== null) line("+", to, declared);
  }
  return lines;
}
