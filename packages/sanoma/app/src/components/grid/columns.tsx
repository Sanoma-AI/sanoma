import type { PatchOutput } from "sanoma/workflows";
import type { CollectionEntry } from "sanoma/workflows/describe";
import type { ColumnType, ConvertDecision, TableChangePlan } from "sanoma/workflows/description";
import { changeIdOf, errorMessage, type Saved } from "sanoma/workflows/shared";
import { deepEquals } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { type ColumnSizingState } from "@tanstack/react-table";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { proposeColumnChangeFn } from "../../functions.ts";
import { closeRecord, type ColumnSearch, openColumn, refreshWritten, remoteQuery } from "../../queries.ts";
import { ButtonLink, CardHeading, Notice, ToneBadge } from "../common.tsx";
import { FROM } from "../data-grid.tsx";
import {
  ColumnChange,
  DECIDED,
  DOES,
  happens,
  keysIn,
  landed,
  planOf,
  problemOf,
  requiredOf,
  takenToday,
  typeOf,
  typeWords,
  UNAVAILABLE,
} from "./plan.ts";
import { WontConvertSample } from "./review.tsx";

// A collection's columns from its grid: each field's menu on its heading (Rename, Change type,
// Hide for me, a free-form field's keys to make columns of, Remove for everyone), New column, and
// the panel each opens beside the grid (`?column=`), which proposes the change
// (`proposeColumnChangeFn`) after saying what will happen, drafted over the rows on screen
// (`planOf`), and asks what becomes of the values a type change cannot convert. A column's width
// is this browser's.

/** The columns after the fields, by ids no field can have. */
export const UPDATED = "@updated";
export const BY = "@by";
export const HEADS: Record<string, string> = { [UPDATED]: "Updated", [BY]: "By" };

/** A collection's column widths, in this browser: `localStorage` may refuse to be read or written. */
const widthsKey = (name: string) => `sanoma.grid.${name}.widths`;
export function readWidths(name: string): ColumnSizingState {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(widthsKey(name)) ?? "{}");
    return typeof stored === "object" && stored !== null ? (stored as ColumnSizingState) : {};
  } catch {
    return {};
  }
}
export function writeWidths(name: string, widths: ColumnSizingState) {
  try {
    localStorage.setItem(widthsKey(name), JSON.stringify(widths));
  } catch {
    // A private window, or storage turned off: the widths last as long as the page.
  }
}

/** Where a heading's own control sits: at its right, before its resizer. */
const AT_HEAD_END = "absolute top-1/2 right-2 -translate-y-1/2";

/**
 * A field's menu on its heading: Rename, Change type, Hide for me (the page's `?hide=`, this view
 * alone), on a free-form field the keys its records hold with how many (`rows`, those on screen)
 * to make a column of, and Remove for everyone (the `hide` change, its panel); none on the key,
 * which names each record.
 */
export function ColumnMenu({
  collection,
  field,
  rows,
  hide = [],
}: {
  collection: CollectionEntry;
  field: string;
  rows: readonly Saved[];
  hide: string[] | undefined;
}) {
  const navigate = useNavigate({ from: FROM });
  const open = (column: ColumnSearch) => void navigate({ search: openColumn(column), resetScroll: false });
  const declared = collection.fields[field];
  if (field === collection.key || declared === undefined) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-xs" className={AT_HEAD_END} aria-label={`Change the column ${field}`} />
        }
      >
        <CaretDownIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuItem onClick={() => open({ change: "rename", field })}>Rename</DropdownMenuItem>
        <DropdownMenuItem onClick={() => open({ change: "retype", field })}>Change type</DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            void navigate({
              search: (prev) => ({ ...prev, hide: [...hide, field] }),
              replace: true,
              resetScroll: false,
            })
          }
        >
          <MenuChoice title="Hide for me" detail="Only in your view. Fields shows it again." />
        </DropdownMenuItem>
        {typeOf(declared) === "json" && <KeysIn field={field} rows={rows} open={open} />}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => open({ change: "hide", field })}>
          <MenuChoice title="Remove for everyone…" detail="Leaves the grid and the forms. Its values are kept." />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A menu item's name, with what it does under it. */
function MenuChoice({ title, detail }: { title: string; detail: string }) {
  return (
    <span className="flex flex-col">
      {title}
      <span className="text-xs text-muted-foreground">{detail}</span>
    </span>
  );
}

/**
 * The keys a free-form field's records hold, with how many (`rows`, those on screen), each to make
 * a column of: counted only while its menu is open, since the menu's content mounts then.
 */
function KeysIn({
  field,
  rows,
  open,
}: {
  field: string;
  rows: readonly Saved[];
  open: (column: ColumnSearch) => void;
}) {
  const keys = keysIn(rows, field);
  if (keys.length === 0) return null;
  return (
    <DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Convert to column: found in this free-form column</DropdownMenuLabel>
      {keys.map(({ key, count }) => (
        <DropdownMenuItem key={key} onClick={() => open({ change: "convert", field, key })}>
          <code className="text-xs">{key}</code>
          <span className="ml-auto text-xs text-muted-foreground">in {count}</span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuGroup>
  );
}

/** New column: the panel, opened from the last heading's "+". */
export function NewColumnLink() {
  return (
    <ButtonLink variant="ghost" size="icon-xs" className={AT_HEAD_END}>
      <Link from={FROM} search={openColumn({ change: "add" })} resetScroll={false} preload={false}>
        <PlusIcon aria-hidden="true" />
        <span className="sr-only">New column</span>
      </Link>
    </ButtonLink>
  );
}

/** The type chips, in the order the panel offers them. */
const CHOICES = "choice";
const TYPES: { label: string; type: ColumnType | typeof CHOICES }[] = [
  { label: "Text", type: "text" },
  { label: "Number", type: "number" },
  { label: "Yes / no", type: "boolean" },
  { label: "Date", type: "date" },
  { label: "A person", type: "person" },
  { label: "A choice", type: CHOICES },
  { label: "Link to another table", type: { link: "" } },
  { label: "Free-form", type: "json" },
];
const isChoice = (type: ColumnType): type is Extract<ColumnType, { enum: unknown }> =>
  typeof type === "object" && "enum" in type;
const sameChip = (a: ColumnType | typeof CHOICES, b: ColumnType) => (a === CHOICES ? isChoice(b) : deepEquals(a, b));

/** The panel's heading for each change. */
function titleOf(collection: CollectionEntry, { change, field, key }: ColumnSearch) {
  switch (change) {
    case "add":
      return `New column in ${collection.name}`;
    case "rename":
      return `Rename ${field}`;
    case "retype":
      return `Change the type of ${field}`;
    case "convert":
      return `Make ${key} of ${field} a column`;
    case "hide":
      return `Remove ${field} for everyone`;
  }
}

/**
 * The column panel beside the grid: what `column` changes, with the fields it takes (a name, a
 * type of the chips, its choices, Optional), What will happen over `rows` (those on screen) in
 * plain words, for a type change with values that won't convert those values and what becomes of
 * them (the plan's `decision`, asked before it goes on), and Review the change, which proposes it:
 * a change to review, or, with no remote, the data file written and what became of the records.
 */
export function ColumnPanel({
  collection,
  column,
  rows,
}: {
  collection: CollectionEntry;
  column: ColumnSearch;
  rows: readonly Saved[];
}) {
  const navigate = useNavigate({ from: FROM });
  const queryClient = useQueryClient();
  const remote = useQuery(remoteQuery()).data;
  const declared = column.field === undefined ? undefined : collection.fields[column.field];
  const [name, setName] = useState(column.change === "rename" ? (column.field ?? "") : "");
  const [type, setType] = useState<ColumnType>(declared && column.change === "retype" ? typeOf(declared) : "text");
  const [choices, setChoices] = useState(isChoice(type) ? type.enum.join("\n") : "");
  const [optional, setOptional] = useState(true);
  const [decision, setDecision] = useState<ConvertDecision>();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string>();
  const field = column.field ?? "";
  const typed: ColumnType = isChoice(type)
    ? { enum: choices.split("\n").flatMap((line) => (line.trim() ? [line.trim()] : [])) }
    : type;
  const intent = {
    add: { kind: "add", field: name, type: typed, required: !optional },
    rename: { kind: "rename", from: field, to: name },
    retype: { kind: "retype", field, to: typed, decision },
    convert: { kind: "convert", field, key: column.key ?? "", type: typed, decision },
    hide: { kind: "hide", field },
  }[column.change];
  const parsed = ColumnChange.safeParse(intent);
  const problem = parsed.success ? problemOf(collection, parsed.data) : parsed.error.issues[0]?.message;
  const plan = parsed.success && !problem ? planOf(collection, rows, parsed.data) : undefined;
  const unchanged =
    (column.change === "rename" && name === field) ||
    (column.change === "retype" && declared !== undefined && deepEquals(typed, typeOf(declared)));
  // A retype's or a conversion's values that won't convert, among those on screen: what becomes of them is asked.
  const [planned] = plan?.changes ?? [];
  const wont = planned && "wontConvert" in planned && !unchanged ? planned.wontConvert : undefined;
  const asks = wont !== undefined && wont.count > 0;

  async function propose() {
    if (!parsed.success) return;
    setSending(true);
    setFailed(undefined);
    try {
      const answer = await proposeColumnChangeFn({ data: { collection: collection.name, change: parsed.data } });
      if ("change" in answer) {
        await navigate({ to: "/changes/$id", params: { id: changeIdOf(answer.change) ?? answer.change } });
        return;
      }
      said(answer, plan);
      await refreshWritten(queryClient, answer.file);
      await navigate({ search: closeRecord, resetScroll: false });
    } catch (err) {
      setFailed(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card aria-label={titleOf(collection, column)} role="region" className="lg:sticky lg:top-4">
      <CardHeader>
        <CardHeading className="self-center">{titleOf(collection, column)}</CardHeading>
        <CardAction>
          <ButtonLink variant="ghost" size="icon-sm">
            <Link from={FROM} search={closeRecord} resetScroll={false}>
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Link>
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void propose();
          }}
        >
          {(column.change === "add" || column.change === "rename") && (
            <Field>
              <FieldLabel htmlFor="column-name">Name</FieldLabel>
              <Input id="column-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              <FieldDescription>Letters and numbers, no spaces. You can rename it later.</FieldDescription>
            </Field>
          )}
          {(column.change === "add" || column.change === "retype" || column.change === "convert") && (
            <FieldSet>
              <FieldLegend variant="label">Type</FieldLegend>
              <div className="flex flex-wrap gap-1.5">
                {TYPES.map((chip) => {
                  const on = sameChip(chip.type, type);
                  const offered = chip.type === CHOICES || takenToday(chip.type);
                  return (
                    <Button
                      key={chip.label}
                      type="button"
                      size="sm"
                      variant={on ? "default" : "outline"}
                      aria-pressed={on}
                      disabled={!offered}
                      title={offered ? undefined : UNAVAILABLE}
                      onClick={() => setType(chip.type === CHOICES ? { enum: [] } : chip.type)}
                    >
                      {chip.label}
                    </Button>
                  );
                })}
              </div>
            </FieldSet>
          )}
          {isChoice(type) && (
            <Field>
              <FieldLabel htmlFor="column-choices">
                Choices <span className="font-normal text-muted-foreground">· one per line</span>
              </FieldLabel>
              <Textarea id="column-choices" rows={3} value={choices} onChange={(e) => setChoices(e.target.value)} />
            </Field>
          )}
          {column.change === "add" && (
            <Field orientation="horizontal">
              <Checkbox id="column-optional" checked={optional} onCheckedChange={setOptional} />
              <FieldLabel htmlFor="column-optional" className="font-normal">
                Optional <span className="text-muted-foreground">· existing records stay valid with it empty</span>
              </FieldLabel>
            </Field>
          )}
          {column.change === "retype" && declared !== undefined && !requiredOf(declared) && (
            <p className="text-sm text-muted-foreground">It stays optional.</p>
          )}
          <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2.5" role="status">
            <span className="text-xs text-muted-foreground">
              What will happen, over the records on screen (the review counts every one)
            </span>
            <span className="text-sm">{unchanged ? "Nothing changes." : plan ? happens(plan) : problem}</span>
          </div>
          {asks && (
            <FieldSet>
              <FieldLegend variant="label">
                {wont.count === 1 ? "This value can't" : `These ${wont.count} values can't`} convert to{" "}
                {typeWords(typed)}
              </FieldLegend>
              <WontConvertSample keyField={collection.key} field={column.key ?? field} wontConvert={wont} />
              <RadioGroup value={decision ?? null} onValueChange={(value) => setDecision(value as ConvertDecision)}>
                {(["clear", "keep"] as const).map((choice) => (
                  <Field key={choice} orientation="horizontal">
                    <RadioGroupItem value={choice} id={`column-decision-${choice}`} />
                    <FieldContent>
                      <FieldLabel htmlFor={`column-decision-${choice}`}>{DECIDED[choice](wont.count)}</FieldLabel>
                      <FieldDescription>{DOES[choice]}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
          )}
          {failed && <Notice variant="destructive">{failed}</Notice>}
          <div className="flex items-center gap-2">
            {remote && <ToneBadge tone="waiting">Waits for admin</ToneBadge>}
            <Button type="submit" className="ml-auto" disabled={!plan || unchanged || (asks && !decision) || sending}>
              {sending ? "Opening the change…" : "Review the change"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * A column change written without a remote, said in a toast: the file, then what became of the
 * records (`landed`, over the panel's `plan`, whose names are the change's), and whether it shows
 * once Sanoma starts again; when the records could not be brought along, that the file is written
 * and they are as they were, and why.
 */
function said({ file, reshaped, running }: Exclude<PatchOutput, { change: string }>, plan?: TableChangePlan) {
  const later = running === false ? ["It shows here once Sanoma starts again."] : [];
  if (reshaped && "error" in reshaped) {
    toast.error(`Saved in ${file}, but its records weren't brought along: ${reshaped.error}`, {
      description: ["They hold what they held before.", ...later].join(" "),
      duration: Infinity,
    });
    return;
  }
  const what = reshaped && plan ? [landed(plan, reshaped)] : [];
  toast.success(`Saved in ${file}.`, { description: [...what, ...later].join(" ") || undefined });
}
