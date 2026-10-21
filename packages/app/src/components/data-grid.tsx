import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import type { Saved } from "@sanoma-ai/workflows/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { Field, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { type DataSearch, RECORDS_LIMIT } from "../queries.ts";
import { Nothing, Tip, ToneBadge, When } from "./common.tsx";
import { LinkRow } from "./runs-table.tsx";

// A collection's grid: its records as a table, a column per field and then who saved each and
// when, sorted by any field, filtered by key and by each enum field, at most `limit` of them.
// What it shows is the page's search (`DataSearch`), which the page reads `list` with.

/** The search of the grid's page: what each control writes. */
const FROM = "/data/$name";

/** The filters of a collection's grid: a key's start, each enum field's value, and the limit. */
export function GridFilters({ collection, search }: { collection: CollectionEntry; search: DataSearch }) {
  const navigate = useNavigate({ from: FROM });
  const set = (next: Partial<DataSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true, resetScroll: false });
  // The key typed so far: the URL follows it, and the grid with it.
  const [key, setKey] = useState(search.key ?? "");
  const enums = Object.entries(collection.fields).flatMap(([name, kind]) =>
    typeof kind === "object" && "enum" in kind ? [{ name, values: kind.enum }] : [],
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="w-56">
        <FieldLabel htmlFor="grid-key">{collection.key} starts with</FieldLabel>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="grid-key"
            type="search"
            autoComplete="off"
            className="pl-8"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              set({ key: e.target.value || undefined });
            }}
          />
        </div>
      </Field>
      {enums.map(({ name, values }) => (
        <Field key={name} className="w-auto">
          <FieldLabel htmlFor={`grid-where-${name}`}>{name}</FieldLabel>
          <NativeSelect
            id={`grid-where-${name}`}
            value={search.where?.[name] ?? ""}
            onChange={(e) => {
              const { [name]: _, ...rest } = search.where ?? {};
              const where = e.target.value ? { ...rest, [name]: e.target.value } : rest;
              set({ where: Object.keys(where).length ? where : undefined });
            }}
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {values.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ))}
      <Field className="w-auto">
        <FieldLabel htmlFor="grid-limit">Show at most</FieldLabel>
        <NativeSelect
          id="grid-limit"
          value={String(search.limit ?? RECORDS_LIMIT.default)}
          onChange={(e) => set({ limit: Number(e.target.value) })}
        >
          {/* A limit typed into the URL is kept among them. */}
          {[...new Set([...RECORDS_LIMIT.choices, search.limit ?? RECORDS_LIMIT.default])]
            .toSorted((a, b) => a - b)
            .map((n) => (
              <NativeSelectOption key={n} value={String(n)}>
                {n}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </Field>
    </div>
  );
}

/**
 * The records as a table: a column per field, in the collection's order, each sortable, then
 * when each was saved and by whom. A record saved under fields that have changed since is
 * flagged, its issues in the flag's tooltip. A row opens its record in the form (`?record=`).
 */
export function DataGrid({
  collection,
  records,
  search,
  limit,
}: {
  collection: CollectionEntry;
  records: Saved[];
  search: DataSearch;
  limit: number;
}) {
  const fields = Object.keys(collection.fields);
  if (records.length === 0) {
    const filtered = search.key !== undefined || search.where !== undefined;
    return (
      <Nothing title={filtered ? "No record matches" : "No records yet"}>
        {filtered ? "Change the filters to see others." : "Add one, or save one from a workflow."}
      </Nothing>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {fields.map((field) => (
                <SortHead key={field} field={field} order={search.order} />
              ))}
              <TableHead>Updated</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((saved) => {
              const open = {
                to: FROM,
                params: { name: collection.name },
                search: (prev: DataSearch) => ({ ...prev, record: saved.key, new: undefined }),
                resetScroll: false,
              } as const;
              return (
                <LinkRow key={saved.key} link={open} selected={saved.key === search.record}>
                  {fields.map((field) => (
                    <TableCell key={field} className={field === collection.key ? "font-medium" : undefined}>
                      {field === collection.key ? (
                        <span className="flex items-center gap-2">
                          <Link {...open} onClick={(e) => e.stopPropagation()}>
                            {saved.key}
                          </Link>
                          {saved.issues && <IssuesFlag issues={saved.issues} />}
                        </span>
                      ) : (
                        <Value value={saved.record[field]} />
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-muted-foreground">
                    <When at={Date.parse(saved.updatedAt)} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{saved.updatedBy}</TableCell>
                </LinkRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {records.length >= limit && (
        <p className="text-sm text-muted-foreground">
          The first {limit} records: filter them, or show more, to see the rest.
        </p>
      )}
    </div>
  );
}

/** A field's heading, sorting by it: ascending, then descending, then by key again. */
function SortHead({ field, order }: { field: string; order: string | undefined }) {
  const sort = order === field ? "ascending" : order === `-${field}` ? "descending" : undefined;
  const next = sort === undefined ? field : sort === "ascending" ? `-${field}` : undefined;
  const Icon = sort === "ascending" ? ArrowUpIcon : sort === "descending" ? ArrowDownIcon : ArrowUpDownIcon;
  return (
    <TableHead aria-sort={sort}>
      <Link
        from={FROM}
        search={(prev) => ({ ...prev, order: next })}
        replace
        resetScroll={false}
        className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
      >
        {field}
        <Icon aria-hidden className={sort ? "size-3.5" : "size-3.5 text-muted-foreground"} />
      </Link>
    </TableHead>
  );
}

/** A field's value as text: yes or no, a list or an object as JSON, a dash for none. */
function Value({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground">-</span>;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return <code className="text-xs">{JSON.stringify(value)}</code>;
  return String(value);
}

/** A record the fields no longer accept: a badge, and where they refuse it in its tooltip. */
function IssuesFlag({ issues }: { issues: NonNullable<Saved["issues"]> }) {
  const text = issues.map(({ path, message }) => (path.length ? `${path.join(".")}: ${message}` : message)).join("; ");
  return (
    <Tip tip={`Saved before its fields changed: ${text}`}>
      <ToneBadge tone="bad" tabIndex={0}>
        needs fixing
      </ToneBadge>
    </Tip>
  );
}
