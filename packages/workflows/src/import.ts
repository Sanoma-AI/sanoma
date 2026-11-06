import type { Saved } from "./shared.ts";

// A sheet imported into a collection: its rows, already read into cells (the app reads a CSV
// file), and which field each column fills. Pure and browser-safe (`shared.ts` re-exports it):
// the built-in `import` (`import-workflow.ts`) and the app's Review page read a sheet the one
// way, so what a page shows will be added is what the run adds.

/** A column of the sheet in an import: the field it fills, and what its values stand for (`"In talks"` → `"meeting"`). */
export interface ImportColumn {
  field: string;
  /** A cell's text (trimmed) as the field's value: an enum's labels, a person's name or email as their id. */
  values?: Record<string, string>;
}

/** What the built-in `import` takes: the collection, each column's field (null to skip it), and the rows under the header. */
export interface ImportInput {
  collection: string;
  /** One per column of `rows`, in the sheet's order. */
  mapping: (ImportColumn | null)[];
  /** The sheet's rows after its header, each a list of cells as text. */
  rows: string[][];
  /** The declared people's ids: a person field refuses anyone else. Without it, any text is taken as an id. */
  people?: string[];
}

/** A row an import leaves for the person: its number in the sheet (the header is row 1), its key when it has one, and why. */
export interface ImportProblem {
  row: number;
  key?: string;
  reason: string;
}

/** What an import did: how many records it added, updated, and found as the sheet has them, and the rows it left. */
export interface ImportOutput {
  added: number;
  updated: number;
  unchanged: number;
  /** In the sheet's order. */
  problems: ImportProblem[];
}

/** A row as the fields take it: its number in the sheet, its key, and the fields its cells fill. */
export interface ImportRow {
  row: number;
  key: string;
  fields: Record<string, unknown>;
}

/** What saving a row does: adds it, updates the record there, changes nothing, or needs fixing first. */
export type ImportEntry =
  | { will: "add"; record: Record<string, unknown> }
  | { will: "update"; record: Record<string, unknown>; was: Record<string, unknown> }
  | { will: "keep" }
  | { will: "fix"; reason: string };

/** How many rows an import saves at once: one `saveMany` each, which a hold waits on whole. */
export const IMPORT_BATCH = 200;

/** The sheet's row the first of `rows` is: the header is row 1. */
const FIRST_ROW = 2;

/** A collection's field as an import reads its declaration: a type, `{ type, optional }` or `{ enum, optional }`. */
type Declared = string | { type?: string; enum?: readonly string[]; optional?: boolean };

/** What an import reads of a collection: its key and its fields as declared. */
export interface ImportTarget {
  key: string;
  fields: Readonly<Record<string, Declared>>;
}

/**
 * The columns `mapping` fills that are wrong for `collection`, as sentences: a field it lacks,
 * one filled twice, its key filled by none. The workflow's input refuses them; a page shows them.
 */
export function mappingProblems({ key, fields }: ImportTarget, mapping: ImportInput["mapping"]): string[] {
  const problems: string[] = [];
  const filled = mapping.flatMap((column) => (column ? [column.field] : []));
  for (const field of new Set(filled)) {
    if (!Object.hasOwn(fields, field)) problems.push(`There is no field ${field}`);
    else if (filled.indexOf(field) !== filled.lastIndexOf(field)) problems.push(`Two columns fill ${field}`);
  }
  if (!filled.includes(key)) problems.push(`No column fills ${key}, the key`);
  return problems;
}

/**
 * The rows of a sheet as the collection's fields take them, each with the fields its cells fill
 * (an empty cell fills none), and the rows they refuse: a value its field does not take, no key,
 * or a key an earlier row has. A cell is trimmed, then given its column's `values`, then read as
 * its field's type: a number as JavaScript writes one, true or false as yes, no, true, false, 1
 * or 0, a date as ISO 8601 (a day, or a time with its offset), an enum's value as written, and a
 * person as one of `people` when given. Throws on a mapping `mappingProblems` refuses.
 */
export function importRows(
  collection: ImportTarget,
  { mapping, rows, people }: Pick<ImportInput, "mapping" | "rows" | "people">,
): { rows: ImportRow[]; problems: ImportProblem[] } {
  const wrong = mappingProblems(collection, mapping);
  if (wrong.length) throw new Error(`The import's columns are wrong: ${wrong.join("; ")}`);
  const declared = people && new Set(people);
  const read: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  const firstWith = new Map<string, number>();
  rows.forEach((cells, i) => {
    const row = FIRST_ROW + i;
    const fields: Record<string, unknown> = {};
    const refused: string[] = [];
    mapping.forEach((column, at) => {
      if (!column) return;
      const cell = (cells[at] ?? "").trim();
      const text = column.values?.[cell] ?? cell;
      if (text === "") return;
      const value = valueOf(collection.fields[column.field]!, text, declared);
      if ("refused" in value) refused.push(`${column.field}: "${cell}" ${value.refused}`);
      else fields[column.field] = value.value;
    });
    const key = fields[collection.key];
    const first = typeof key === "string" ? firstWith.get(key) : undefined;
    if (typeof key !== "string") refused.unshift(`no ${collection.key}, the key`);
    else if (first !== undefined) refused.unshift(`${collection.key} "${key}" is row ${first}'s too`);
    else firstWith.set(key, row);
    if (refused.length) problems.push({ row, ...(typeof key === "string" && { key }), reason: refused.join("; ") });
    else read.push({ row, key: key as string, fields });
  });
  return { rows: read, problems };
}

/**
 * What saving `row` does, given the record its key has (`existing`, as `get` or `list` answer
 * it): a new record of the fields the row fills, refused while a required one is empty; an
 * update of those fields over the record's others, refused where the record holds what the
 * fields no longer take and the row does not replace it; nothing when the update changes nothing.
 */
export function importEntry(collection: ImportTarget, row: ImportRow, existing: Saved | undefined): ImportEntry {
  const record = { ...existing?.record, ...row.fields };
  const stale = [
    ...Object.keys(record).filter((field) => !Object.hasOwn(collection.fields, field)),
    ...(existing?.issues ?? []).map((issue) => String(issue.path[0])).filter((field) => !(field in row.fields)),
  ];
  if (stale.length) {
    return { will: "fix", reason: `the record's ${[...new Set(stale)].join(", ")} the fields refuse: fix it first` };
  }
  const missing = Object.entries(collection.fields)
    .filter(([field, kind]) => !(typeof kind === "object" && kind.optional) && record[field] === undefined)
    .map(([field]) => field);
  if (missing.length) return { will: "fix", reason: `needs ${missing.join(", ")}` };
  if (!existing) return { will: "add", record };
  return sameRecord(record, existing.record) ? { will: "keep" } : { will: "update", record, was: existing.record };
}

/**
 * Orders text by code point, as Postgres orders a collection's keys (`COLLATE "C"`), which a
 * range of keys (`gte`, `lte`) is read by; `<` orders UTF-16 code units, which differ past U+FFFF.
 */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** True when two records hold the same fields and values, whatever their order. */
const sameRecord = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = Object.keys(a).filter((k) => a[k] !== undefined);
  return (
    keys.length === Object.keys(b).filter((k) => b[k] !== undefined).length &&
    keys.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
  );
};

const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;
const TRUE = new Set(["true", "yes", "y", "1"]);
const FALSE = new Set(["false", "no", "n", "0"]);
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// As `collection()`'s schema takes a time: seconds, any fraction, and an offset, `Z` or `±hh:mm`.
const TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** True for a day of the calendar written `yyyy-mm-dd`. */
const isDay = (text: string) => {
  const m = DAY.exec(text);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/** A cell's text as its field's value, or why the field refuses it (after the quoted text). */
function valueOf(kind: Declared, text: string, people: ReadonlySet<string> | undefined) {
  if (typeof kind === "object" && kind.enum) {
    return kind.enum.includes(text) ? { value: text } : { refused: `is not one of ${kind.enum.join(", ")}` };
  }
  switch (typeof kind === "object" ? kind.type : kind) {
    case "number": {
      const n = Number(text);
      return NUMBER.test(text) && Number.isFinite(n) ? { value: n } : { refused: "is not a number" };
    }
    case "boolean": {
      const lower = text.toLowerCase();
      return TRUE.has(lower) ? { value: true } : FALSE.has(lower) ? { value: false } : { refused: "is not yes or no" };
    }
    case "date": {
      const time = TIME.exec(text);
      return isDay(text) || (time && isDay(time[1]!))
        ? { value: text }
        : { refused: "is not a date as 2026-11-01 writes one" };
    }
    case "person":
      return !people || people.has(text) ? { value: text } : { refused: "is nobody declared" };
    default:
      return { value: text };
  }
}
