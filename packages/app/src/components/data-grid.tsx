import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import { LIST_LIMIT, type Saved } from "@sanoma-ai/workflows/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowsDownUpIcon } from "@phosphor-icons/react/dist/csr/ArrowsDownUp";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Field, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { TableHead } from "#/components/ui/table.tsx";
import { issueText } from "../form/schema.ts";
import { type DataSearch, enumFields, LIMIT_CHOICES } from "../queries.ts";
import { plural, Tip, ToneBadge } from "./common.tsx";
import { STAGED_FIRST } from "./grid/staged.tsx";

// A collection's grid's pieces around the cells (`grid/` draws the grid): its filters, sorted by
// any field, filtered by key and by each enum field, at most `limit` of them, some fields hidden;
// a field's heading; a value as text; a record its fields refuse. What the grid shows is the
// page's search (`DataSearch`), which the page reads `list` with.

/** The grid's route, whose search each control writes. */
export const FROM = "/data/$name/";

/** How long the key's filter waits after a keystroke before it reads the records again. */
const TYPING_MS = 250;

/**
 * The filters of a collection's grid: a key's start, each enum field's value, and the limit;
 * disabled while a change is `staged`, which another search's records would lose.
 */
export function GridFilters({
  collection,
  search,
  staged,
}: {
  collection: CollectionEntry;
  search: DataSearch;
  staged: boolean;
}) {
  const navigate = useNavigate({ from: FROM });
  const set = (next: Partial<DataSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true, resetScroll: false });
  // The key typed so far; the URL, and the grid with it, follow once typing pauses. A URL that
  // changes otherwise (Back, a link) sets it, but not the URL catching up with what was typed.
  const [key, setKey] = useState(search.key ?? "");
  const written = useRef(search.key);
  useEffect(() => {
    if (search.key === written.current) return;
    written.current = search.key;
    setKey(search.key ?? "");
  }, [search.key]);
  useEffect(() => {
    if ((key || undefined) === written.current) return;
    const timer = setTimeout(() => {
      written.current = key || undefined;
      set({ key: written.current });
    }, TYPING_MS);
    return () => clearTimeout(timer);
    // Typing alone writes the URL: not the URL's own change, which the effect above follows.
  }, [key]);
  const limit = search.limit ?? LIST_LIMIT.default;
  const filters = (
    <fieldset disabled={staged} className="flex flex-wrap items-end gap-3">
      <Field className="w-56">
        <FieldLabel htmlFor="grid-key">{collection.key} starts with</FieldLabel>
        <div className="relative">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="grid-key"
            type="search"
            autoComplete="off"
            className="pl-8"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
      </Field>
      {enumFields(collection.fields).map(({ name, values }) => (
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
        <NativeSelect id="grid-limit" value={String(limit)} onChange={(e) => set({ limit: Number(e.target.value) })}>
          {/* A limit typed into the URL is kept among them. */}
          {[...new Set<number>([...LIMIT_CHOICES, limit])]
            .toSorted((a, b) => a - b)
            .map((n) => (
              <NativeSelectOption key={n} value={String(n)}>
                {n}
              </NativeSelectOption>
            ))}
        </NativeSelect>
      </Field>
      <HiddenFields collection={collection} hide={search.hide} set={set} />
    </fieldset>
  );
  return staged ? <Tip tip={STAGED_FIRST}>{filters}</Tip> : filters;
}

/**
 * Which fields the grid shows (`?hide=`): a menu of the fields but the key, which names each
 * row, and New column (the column panel, `grid/columns.tsx`); while some are hidden, a chip
 * saying how many that shows them all again.
 */
function HiddenFields({
  collection,
  hide = [],
  set,
}: {
  collection: CollectionEntry;
  hide: string[] | undefined;
  set: (next: Partial<DataSearch>) => void;
}) {
  const fields = Object.keys(collection.fields).filter((field) => field !== collection.key);
  const hidden = fields.filter((field) => hide.includes(field));
  const toggle = (field: string, shown: boolean) => {
    const next = shown ? hidden.filter((f) => f !== field) : [...hidden, field];
    set({ hide: next.length ? next : undefined });
  };
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          <EyeSlashIcon aria-hidden="true" data-icon="inline-start" />
          Fields
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-44">
          {fields.map((field) => (
            <DropdownMenuCheckboxItem
              key={field}
              checked={!hidden.includes(field)}
              onCheckedChange={(shown) => toggle(field, shown)}
            >
              {field}
            </DropdownMenuCheckboxItem>
          ))}
          {fields.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onClick={() => set({ column: { change: "add" }, record: undefined, new: undefined })}>
            New column
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {hidden.length > 0 && (
        <Button variant="secondary" size="sm" onClick={() => set({ hide: undefined })}>
          {plural(hidden.length, "field")} hidden
          <XIcon aria-hidden="true" data-icon="inline-end" />
          <span className="sr-only">: show them all</span>
        </Button>
      )}
    </div>
  );
}

/**
 * A field's heading, sorting by it: ascending, then descending, then by key again; disabled while
 * a change is `staged`. Not preloaded: hovering a heading would read the records in its order.
 */
export function SortHead({
  field,
  order,
  staged,
  children,
  ...props
}: { field: string; order: string | undefined; staged: boolean } & ComponentProps<typeof TableHead>) {
  const sort = order === field ? "ascending" : order === `-${field}` ? "descending" : undefined;
  const next = sort === undefined ? field : sort === "ascending" ? `-${field}` : undefined;
  const Icon = sort === "ascending" ? ArrowUpIcon : sort === "descending" ? ArrowDownIcon : ArrowsDownUpIcon;
  const link = (
    <Link
      from={FROM}
      search={(prev) => ({ ...prev, order: next })}
      disabled={staged}
      replace
      resetScroll={false}
      preload={false}
      className="inline-flex items-center gap-1 underline-offset-4 hover:underline aria-disabled:no-underline"
    >
      {field}
      <Icon aria-hidden className={sort ? "size-3.5" : "size-3.5 text-muted-foreground"} />
    </Link>
  );
  return (
    <TableHead aria-sort={sort} {...props}>
      {staged ? <Tip tip={STAGED_FIRST}>{link}</Tip> : link}
      {children}
    </TableHead>
  );
}

/** A field's value as text: yes or no, a list or an object as JSON, a dash for none. */
export function Value({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="text-muted-foreground">-</span>;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return <code className="text-xs">{JSON.stringify(value)}</code>;
  return String(value);
}

/** A record the fields no longer accept: a badge, and where they refuse it in its tooltip. */
export function IssuesFlag({ issues }: { issues: NonNullable<Saved["issues"]> }) {
  const text = issues.map(issueText).join("; ");
  return (
    <Tip tip={`Saved before its fields changed: ${text}`}>
      <ToneBadge tone="bad" tabIndex={0}>
        needs fixing
      </ToneBadge>
    </Tip>
  );
}
