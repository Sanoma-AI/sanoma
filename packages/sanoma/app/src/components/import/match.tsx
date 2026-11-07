import type { CollectionEntry } from "sanoma/workflows/describe";
import { type ImportColumn, type ImportInput, importRows, mappingProblems } from "sanoma/workflows/shared";
import { Fragment } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { plural } from "#/lib/utils.ts";
import { CardHeading, Notice, ToneBadge } from "../kit.tsx";
import { columnOf, fieldNamed, type Person, type Sheet, type ValueToMap, valuesToMap } from "./sheet.ts";

// The import's second step: each column of the sheet matched to a field, the values a field does
// not take as written mapped to one it does, and the rows the fields would still refuse.
// Presentational: the page keeps the mapping, which `onMapping` replaces.

/** How many of the rows the fields refuse Match columns lists. */
const LISTED = 5;

/** What a value's choice is when the row is to be fixed first: the value left unmapped. */
const FIX_FIRST = "\u0000fix";

/**
 * A select per column of the sheet, its field or Skip (a column no field is named for offered as
 * a new field, which the collection's columns must gain first), then each value a field does not
 * take as written with what it stands for, then the rows the fields still refuse. Review (`onNext`)
 * waits for columns the fields take: the key filled, no field twice.
 */
export function MatchColumns({
  collection,
  sheet,
  mapping,
  people,
  onMapping,
  onBack,
  onNext,
}: {
  collection: Pick<CollectionEntry, "name" | "key" | "fields">;
  sheet: Sheet;
  mapping: ImportInput["mapping"];
  people: readonly Person[];
  onMapping(mapping: ImportInput["mapping"]): void;
  onBack(): void;
  onNext(): void;
}) {
  const fields = Object.keys(collection.fields);
  const wrong = mappingProblems(collection, mapping);
  const refused = wrong.length
    ? []
    : importRows(collection, { mapping, rows: sheet.rows, people: people.map((p) => p.id) }).problems;
  const set = (at: number, column: ImportColumn | null) => onMapping(mapping.map((c, i) => (i === at ? column : c)));
  return (
    <Card aria-label="Match columns to fields" role="region">
      <CardHeader>
        <CardHeading>Columns in the sheet → fields in {collection.name}</CardHeading>
        <CardDescription>
          Matched by name; change any. Rows are matched to records by <b className="font-medium">{collection.key}</b>,
          the key.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-2 text-sm">
          {sheet.columns.map((column, at) => {
            const field = mapping[at]?.field;
            return (
              <Fragment key={at}>
                <span className="truncate">{column}</span>
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
                <NativeSelect
                  aria-label={`The field ${column} fills`}
                  className="w-full"
                  value={field ?? ""}
                  onChange={({ target: { value } }) =>
                    set(at, value ? columnOf(collection, sheet, at, value, people) : null)
                  }
                >
                  <NativeSelectOption value="">Skip</NativeSelectOption>
                  {fields.map((f) => (
                    <NativeSelectOption key={f} value={f} disabled={f !== field && mapping.some((c) => c?.field === f)}>
                      {f === collection.key ? `${f} · the key` : f}
                    </NativeSelectOption>
                  ))}
                  {fieldNamed(collection, column) === undefined && (
                    <NativeSelectOption value={`\u0000new:${column}`} disabled>
                      New field: {column} (text): add this field first
                    </NativeSelectOption>
                  )}
                </NativeSelect>
              </Fragment>
            );
          })}
        </div>
        {mapping.map((column, at) =>
          column ? (
            <ValuesToMap
              key={at}
              heading={sheet.columns[at]!}
              column={column}
              values={valuesToMap(collection, sheet, at, column.field, people)}
              choices={choicesOf(collection, column.field, people)}
              onColumn={(next) => set(at, next)}
            />
          ) : null,
        )}
        {wrong.map((problem) => (
          <Notice key={problem} variant="destructive">
            {problem}.
          </Notice>
        ))}
        {refused.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm">
            <span className="flex items-center gap-2">
              <ToneBadge tone="bad">{plural(refused.length, "problem")}</ToneBadge>
              <span>
                The fields refuse these rows: fix them in the sheet and upload it again, or import the rest and fix them
                after. Someone nobody declared can be added in People.
              </span>
            </span>
            <ul className="flex flex-col gap-0.5 text-muted-foreground">
              {refused.slice(0, LISTED).map((problem) => (
                <li key={problem.row}>
                  Row {problem.row}: {problem.reason}
                </li>
              ))}
              {refused.length > LISTED && <li>and {plural(refused.length - LISTED, "more row")}</li>}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={wrong.length > 0}>
          Review
        </Button>
      </CardFooter>
    </Card>
  );
}

/** What a value of the field may stand for: an enum's values, or each declared person (by name). */
function choicesOf(collection: Pick<CollectionEntry, "fields">, field: string, people: readonly Person[]) {
  const kind = collection.fields[field];
  if (typeof kind === "object" && "enum" in kind) return kind.enum.map((value) => ({ value, label: value }));
  return people.map(({ id, name }) => ({ value: id, label: name ? `${name} (${id})` : id }));
}

/**
 * The values a column holds that its field does not take as written, each with how many rows
 * hold it and what it stands for (the column's `values`, which start as `columnOf` guessed them):
 * a value of the field, nothing (left empty), or none (the row left to fix).
 */
function ValuesToMap({
  heading,
  column,
  values,
  choices,
  onColumn,
}: {
  heading: string;
  column: ImportColumn;
  values: ValueToMap[];
  choices: { value: string; label: string }[];
  onColumn(column: ImportColumn): void;
}) {
  if (values.length === 0) return null;
  const chosen = (text: string) =>
    column.values && Object.hasOwn(column.values, text) ? column.values[text]! : FIX_FIRST;
  const choose = (text: string, value: string) => {
    const next = Object.entries(column.values ?? {}).filter(([from]) => from !== text);
    if (value !== FIX_FIRST) next.push([text, value]);
    onColumn({ ...column, values: Object.fromEntries(next) });
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <span className="flex items-center gap-2">
        <ToneBadge tone="waiting">Values to map</ToneBadge>
        <span>
          <b className="font-medium">{heading}</b> has values {column.field} does not take as written.
        </span>
      </span>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
        {values.map(({ text, rows }) => (
          <Fragment key={text}>
            <span className="truncate">
              “{text}” <span className="text-muted-foreground">({plural(rows, "row")})</span>
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              →
            </span>
            <NativeSelect
              aria-label={`What “${text}” stands for`}
              className="w-full"
              value={chosen(text)}
              onChange={(event) => choose(text, event.target.value)}
            >
              <NativeSelectOption value={FIX_FIRST}>Fix first</NativeSelectOption>
              {/* An empty value fills nothing: a new record's field stays empty, a record's own stays. */}
              <NativeSelectOption value="">Leave {column.field} out</NativeSelectOption>
              {choices.map(({ value, label }) => (
                <NativeSelectOption key={value} value={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
