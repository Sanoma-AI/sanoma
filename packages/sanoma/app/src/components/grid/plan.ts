import {
  type CollectionEntry,
  type ColumnType,
  ColumnTypeSchema,
  ConvertDecisionSchema,
  type ReshapeChange,
  type ReshapeOutput,
  type TableChange,
  type TableChangePlan,
} from "sanoma/workflows/description";
import { FIELD_NAME, isRecord, reshaped, type Saved } from "sanoma/workflows/shared";
import { z } from "zod";

// A change to a collection's columns, as a person proposes it from the grid (`ColumnChange`) and
// reviews it on its change's page (`TableChangePlan`, the runtime's: `sanoma/workflows/description`).
// The app drafts the plan here from the rows it read and the declaration (`planOf`); the records
// follow it when it lands (`sanoma.records.reshape`, by `reshaped`, which the counts here use too).

/** A new field's name, as `collection()` takes it. */
const NAME = z.string().regex(FIELD_NAME, "Letters, digits and _, not a digit first");

/** The records a change cannot convert: how many, and at most `SAMPLE` of them by key. */
type WontConvert = Extract<TableChange, { kind: "retype" }>["wontConvert"];

/** How many of the rows that won't convert a plan names. */
const SAMPLE = 20;

/** Why a link or a free-form column cannot be proposed. */
export const UNAVAILABLE = "Links and free-form columns aren't available yet";

/**
 * A change to a collection's columns, as the grid proposes it: a `TableChange` before its rows are
 * counted, a retype's or a conversion's `decision` for the values that won't convert the person's
 * choice in the column panel.
 */
export const ColumnChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add"), field: NAME, type: ColumnTypeSchema, required: z.boolean() }),
  z.strictObject({ kind: z.literal("rename"), from: z.string().min(1), to: NAME }),
  z.strictObject({
    kind: z.literal("retype"),
    field: z.string().min(1),
    to: ColumnTypeSchema,
    decision: ConvertDecisionSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("require"), field: z.string().min(1) }),
  z.strictObject({ kind: z.literal("hide"), field: z.string().min(1) }),
  z.strictObject({ kind: z.literal("link"), field: z.string().min(1), to: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("convert"),
    field: z.string().min(1),
    key: NAME,
    type: ColumnTypeSchema,
    decision: ConvertDecisionSchema.optional(),
  }),
]);
export type ColumnChange = z.infer<typeof ColumnChange>;

/** A field as `collection()` declares it. */
type Field = CollectionEntry["fields"][string];

/** A declared field's type. */
export const typeOf = (field: Field): ColumnType =>
  typeof field === "string" ? field : "enum" in field ? { enum: [...field.enum] } : field.type;

/** Whether a declared field is required: not marked `optional`. */
export const requiredOf = (field: Field): boolean => typeof field === "string" || field.optional !== true;

/** Whether a declared field is hidden: removed from the columns for everyone, its values kept. */
export const isHidden = (field: Field | undefined): boolean => typeof field === "object" && field.hidden === true;

/** The fields the grid and the forms show, in their declared order: every one but the hidden. */
export const shownFields = (fields: CollectionEntry["fields"]): string[] =>
  Object.keys(fields).filter((name) => !isHidden(fields[name]));

/** A field's declaration of `type`, required or `optional: true`, as the data file writes it. */
function fieldOf(type: ColumnType, required: boolean): string | Record<string, unknown> {
  if (typeof type === "string") return required ? type : { type, optional: true };
  return required ? type : { ...type, optional: true };
}

/** Whether a column of `type` can be proposed: not a link or free-form, which `collection()` takes neither of yet. */
export const takenToday = (type: ColumnType): boolean =>
  type !== "json" && !(typeof type === "object" && "link" in type);

const filled = (value: unknown) => value !== undefined && value !== null && value !== "";

/** The records of `rows` whose value `change` cannot convert (`reshaped` keeps or clears it), counted and sampled by key. */
function wontConvert(
  rows: readonly Saved[],
  change: ReshapeChange,
  valueOf: (record: Saved["record"]) => unknown,
): WontConvert {
  const wont = rows.filter(({ record }) => {
    const { did } = reshaped(record, change);
    return did === "kept" || did === "cleared";
  });
  return {
    count: wont.length,
    sample: wont.slice(0, SAMPLE).map(({ key, record }) => ({ key, value: valueOf(record) })),
  };
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
    return UNAVAILABLE;
  }
  if (change.kind === "convert" && typeOf(fields[change.field]!) !== "json") return `${change.field} is not free-form`;
  return undefined;
}

/**
 * The plan of `change` to `collection`, over `rows`, the records read for it: each row's value
 * counted, a retype's or a conversion's values that will not convert (`reshaped`) sampled, with
 * the person's decision for them when there are some.
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
      const { decision, ...rest } = change;
      const from = typeOf(collection.fields[change.field]!);
      const wont = wontConvert(rows, change, (record) => record[change.field]);
      planned = { ...rest, from, wontConvert: wont, ...(wont.count > 0 && decision && { decision }) };
      break;
    }
    case "require":
      planned = { ...change, empty: rows.length - count(change.field) };
      break;
    case "hide":
      planned = { ...change, filled: count(change.field) };
      break;
    case "link":
      // Every filled value, until the runtime matches them against the other table's keys.
      planned = { ...change, unmatched: count(change.field) };
      break;
    case "convert": {
      const { decision, ...rest } = change;
      const inner = (record: Saved["record"]) => valueAt(record[change.field], change.key);
      const wont = wontConvert(rows, change, inner);
      planned = { ...rest, wontConvert: wont, ...(wont.count > 0 && decision && { decision }) };
      break;
    }
  }
  return { collection: collection.name, changes: [planned], rows: rows.length };
}

/** What `patch` takes: the fields to set, and those to rename or remove. */
interface DeclarationEdit {
  fields: Record<string, ReturnType<typeof fieldOf>>;
  rename: Record<string, string | null>;
}
const set = (field: string, type: ColumnType, required: boolean): DeclarationEdit => ({
  fields: { [`fields.${field}`]: fieldOf(type, required) },
  rename: {},
});
const rename = (field: string, to: string | null): DeclarationEdit => ({
  fields: {},
  rename: { [`fields.${field}`]: to },
});
/** A field kept with its values, `hidden: true` (and so optional): what removing a column is. */
const hidden = (field: string, declared: Field): DeclarationEdit => ({
  fields: {
    [`fields.${field}`]: {
      ...(typeof declared === "string" ? { type: declared } : declared),
      optional: true,
      hidden: true,
    },
  },
  rename: {},
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
    case "hide":
      return hidden(change.field, declared!);
    case "link":
      return set(change.field, { link: change.to }, requiredOf(declared!));
    case "convert":
      return set(change.key, change.type, false);
  }
}

/** A type in words: "text", "a number", "a choice: High, Normal or Low". */
export function typeWords(type: ColumnType): string {
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

/** A rename's records, said: each value moves to the new name when the change lands. */
export const renamed = (plan: TableChangePlan) => `${allRecords(plan)} keep their values under the new name.`;

/**
 * How many of `what`, in words: `lib/utils.ts`'s `plural`, which this file cannot import, since
 * `api.ts` brings it into the package's build, where `#/` does not resolve.
 */
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const records = (n: number) => count(n, "record");

/** The two choices for the `n` values a retype or a conversion cannot convert, as the column panel offers them. */
export const DECIDED = {
  clear: (n: number) => `Leave ${n === 1 ? "it" : `these ${n}`} empty`,
  keep: (n: number) => `Keep ${n === 1 ? "it" : "them"} as ${n === 1 ? "it is" : "they are"}`,
} as const;

/** What each choice does to those values, in a sentence. */
export const DOES = {
  clear: "This removes what they hold now.",
  keep: "They show as needs fixing in the grid until someone edits them.",
} as const;

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
      return `${change.from} is called ${change.to} from now on. ${renamed(plan)}`;
    case "retype":
    case "convert": {
      const to = change.kind === "retype" ? change.to : change.type;
      const what = change.kind === "retype" ? change.field : `${change.field}'s ${change.key}`;
      const wont = change.wontConvert.count;
      const becomes = `${what} becomes ${typeWords(to)}.`;
      if (wont === 0) return `${becomes} Every value converts.`;
      const cant = `${records(wont)} can't convert`;
      if (change.decision === "clear") return `${becomes} ${cant}: they're left empty, and lose what they hold now.`;
      if (change.decision === "keep") return `${becomes} ${cant}: they keep what they hold and show as needs fixing.`;
      return `${becomes} ${cant}. Choose below what happens to them.`;
    }
    case "require":
      return change.empty === 0
        ? `${change.field} is required from now on. Every record has it.`
        : `${change.field} is required from now on. ${records(change.empty)} have it empty, and need one before they save again.`;
    case "hide":
      return change.filled === 0
        ? `${change.field} leaves the grid and the forms for everyone. No record has a value in it.`
        : `${change.field} leaves the grid and the forms for everyone. Its values in ${records(change.filled)} are kept.`;
    case "link":
      return `${change.field} links to ${change.to}.`;
    case undefined:
      return "Nothing changes.";
  }
}

/**
 * What became of the records once `plan` landed (`counts`, `sanoma.records.reshape`'s answer), in
 * sentences: a rename's records under the new name, then the values converted, left empty or kept
 * to fix. Counted by the plan's one change that brings the records along; a plan of several says
 * the counts together.
 */
export function landed(plan: TableChangePlan, counts: ReshapeOutput): string {
  const along = plan.changes.filter((change) => change.kind === "rename" || "wontConvert" in change);
  const one = along.length === 1;
  const said: string[] = [];
  for (const change of along) {
    if (change.kind !== "rename") continue;
    if (!one) said.push(`The values of ${change.from} are under ${change.to} now.`);
    else if (counts.changed === 0) said.push(`No record had a value in ${change.from}.`);
    else said.push(`${records(counts.changed)} now ${counts.changed === 1 ? "holds" : "hold"} ${change.to}.`);
  }
  const typed = along.filter((change) => change.kind !== "rename");
  if (typed.length) {
    const [first] = typed;
    const value = one && first ? `${first.kind === "retype" ? first.field : first.key} value` : "value";
    const { converted, cleared, kept } = counts;
    if (converted + cleared + kept === 0) said.push(`No ${value} needed converting.`);
    else {
      const parts = [
        `${count(converted, value)} converted`,
        ...(cleared ? [`${cleared} left empty`] : []),
        ...(kept ? [`${kept} kept as ${kept === 1 ? "it was" : "they were"}, to fix in the grid`] : []),
      ];
      said.push(`${parts.join(", ")}.`);
    }
  }
  return said.join(" ");
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
        else if (change.kind !== "hide") line("+", name, undefined);
        continue;
      }
    }
    const edit = declarationEdit(fields, change);
    for (const [path, value] of Object.entries(edit.fields)) line("+", path.slice("fields.".length), value);
    for (const to of Object.values(edit.rename)) if (to !== null) line("+", to, declared);
  }
  return lines;
}
