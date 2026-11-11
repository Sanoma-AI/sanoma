import type { CollectionEntry } from "sanoma/workflows/describe";
import {
  byCodePoint,
  type ImportColumn,
  type ImportEntry,
  importEntry,
  type ImportInput,
  importRows,
  type Saved,
} from "sanoma/workflows/shared";
import { cellsOf } from "../grid/clipboard.ts";
import { shownFields } from "../grid/plan.ts";

// A sheet on its way into a collection, pure: the file read into a header and rows, each column
// matched to a field by name, the values a field does not take as written, and what saving each
// row will do, read the way the built-in `import` reads them (`importRows`, `importEntry`), so
// the Review page says what the run will do.

/** A sheet as an import reads it: the file's name, its header's names, and the rows under it. */
export interface Sheet {
  file: string;
  columns: string[];
  rows: string[][];
}

/**
 * A CSV file's text as a sheet (RFC 4180, `cellsOf`): its first row the header (an empty name
 * is `Column <n>`), the rows under it but the blank ones at its end, a byte-order mark left out.
 * A blank row between keeps its place, so each row keeps its number in the file (`importRows`
 * skips it). Undefined for a file with no header.
 */
export function readSheet(file: string, text: string): Sheet | undefined {
  const [header, ...rows] = cellsOf(text.replace(/^﻿/, ""), ",");
  if (!header) return undefined;
  return {
    file,
    columns: header.map((name, i) => name.trim() || `Column ${i + 1}`),
    rows: rows.slice(0, rows.findLastIndex((row) => row.some((cell) => cell.trim() !== "")) + 1),
  };
}

/** A declared person, as a sheet may name them. */
export interface Person {
  id: string;
  name?: string;
  email?: string;
}

/** A value a column holds that its field does not take as written: how many rows hold it, and what it stands for by default. */
export interface ValueToMap {
  text: string;
  rows: number;
  /** An enum's value of that name, whatever its case; a person of that id, name or email; none when nothing fits. */
  guess?: string;
}

/**
 * The values of the column `at` that its field does not take as written, in the order the sheet
 * first has them: an enum's other labels, and for a person, anything but a declared id (a name,
 * an email, or nobody's). None for a field of another kind.
 */
export function valuesToMap(
  collection: Pick<CollectionEntry, "fields">,
  sheet: Pick<Sheet, "rows">,
  at: number,
  field: string,
  people: readonly Person[],
): ValueToMap[] {
  const kind = collection.fields[field];
  // What the field takes as written, and the names a value may give it: an enum's values, or a
  // person's id, name and email.
  const [taken, names]: [readonly string[], (readonly [name: string, value: string])[]] | [] =
    typeof kind === "object" && "enum" in kind
      ? [kind.enum, kind.enum.map((value) => [value, value] as const)]
      : // A person field takes any id while nobody is declared, as `importRows` does.
        (typeof kind === "object" ? kind.type : kind) === "person" && people.length > 0
        ? [
            people.map((person) => person.id),
            people.flatMap(({ id, name, email }) => [id, name, email].flatMap((n) => (n ? [[n, id] as const] : []))),
          ]
        : [];
  if (!taken || !names) return [];
  const ids = new Set(taken);
  const counts = new Map<string, number>();
  for (const row of sheet.rows) {
    const text = (row[at] ?? "").trim();
    if (text !== "" && !ids.has(text)) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, rows]) => {
    const guess = names.find(([name]) => name.toLowerCase() === text.toLowerCase())?.[1];
    return { text, rows, ...(guess !== undefined && { guess }) };
  });
}

/** A name as matching compares it: lower case, letters and digits only (`Last touched` is `lasttouched`). */
const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** The field a column's name names, as `plain` reads both; undefined for none. */
export const fieldNamed = (collection: Pick<CollectionEntry, "fields">, column: string): string | undefined =>
  shownFields(collection.fields).find((field) => plain(field) === plain(column));

/** The column `at` filling `field`, its values those `valuesToMap` guesses. */
export function columnOf(
  collection: Pick<CollectionEntry, "fields">,
  sheet: Pick<Sheet, "rows">,
  at: number,
  field: string,
  people: readonly Person[],
): ImportColumn {
  const guessed = valuesToMap(collection, sheet, at, field, people).flatMap(({ text, guess }) =>
    guess === undefined ? [] : [[text, guess] as const],
  );
  return { field, ...(guessed.length && { values: Object.fromEntries(guessed) }) };
}

/** Each column filling the field it names (`fieldNamed`), each field once, its values guessed; null for none. */
export function guessMapping(
  collection: Pick<CollectionEntry, "fields">,
  sheet: Sheet,
  people: readonly Person[],
): ImportInput["mapping"] {
  const taken = new Set<string>();
  return sheet.columns.map((column, at) => {
    const field = fieldNamed(collection, column);
    if (field === undefined || taken.has(field)) return null;
    taken.add(field);
    return columnOf(collection, sheet, at, field, people);
  });
}

/** What the import will do with a row of the sheet, by its number in the sheet. */
export type Planned = ImportEntry & { row: number; key?: string };

/**
 * What importing `input` into `collection` will do with each row, in the sheet's order, given the
 * records its keys have (`found`, by key): as the run reads them, but all at once. Throws on
 * columns `mappingProblems` refuses.
 */
export function planImport(
  collection: Pick<CollectionEntry, "key" | "fields">,
  input: Pick<ImportInput, "mapping" | "rows" | "people">,
  found: ReadonlyMap<string, Saved>,
): Planned[] {
  const { rows, problems } = importRows(collection, input);
  const planned = rows.map((row): Planned => ({
    row: row.row,
    key: row.key,
    ...importEntry(collection, row, found.get(row.key)),
  }));
  const refused = problems.map((problem): Planned => ({ ...problem, will: "fix" }));
  return [...planned, ...refused].toSorted((a, b) => a.row - b.row);
}

/** How many rows the import will add, update, leave as they are, and leave to fix. */
export const countsOf = (planned: readonly Planned[]) =>
  Object.fromEntries(
    (["add", "update", "keep", "fix"] as const).map((will) => [will, planned.filter((p) => p.will === will).length]),
  ) as Record<Planned["will"], number>;

/**
 * The range of keys a list reads to find the records `keys` name (`gte` the first, `lte` the
 * last, as Postgres orders them), or none for no keys.
 */
export function keyRange(keys: readonly string[]): { gte: string; lte: string } | undefined {
  const sorted = keys.toSorted(byCodePoint);
  return sorted.length ? { gte: sorted[0]!, lte: sorted.at(-1)! } : undefined;
}
