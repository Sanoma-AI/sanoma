import type { PreviewAnswer } from "@sanoma-ai/workflows";
import { ANONYMOUS } from "@sanoma-ai/workflows/shared";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { answerWords } from "#/lib/grid-diff.ts";
import { PREVIEW_TONE } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import { ToneBadge } from "./kit.tsx";

// The Permissions grid's table, the Permissions page's and a change's diff of it (permissions-diff.tsx):
// groups across, each workflow's start with the operations it calls under it and each direct
// operation down, and what goes in a cell the caller's.

/** A column: a group's name, `null` for someone in no group, or `anonymous`, who is in none either. */
export type Group = string | null;
/** What a row is about: a workflow's start, or an operation, called in a workflow or directly. */
export type Kind = "workflow" | "op";
/** A row of the table: an id, a title (a workflow's), and under a workflow the operations it uses. */
export interface TableRowOf<R> {
  id: string;
  title?: string;
  ops?: R[];
}

/** Whom a column is about, in words. */
export const someoneIn = (group: Group) => (group === ANONYMOUS ? "anonymous" : `someone in ${group ?? "no group"}`);

/** A column's heading: the group's name, or what the two columns of no group are. */
export const columnLabel = (group: Group) => (group === null ? "No group" : group === ANONYMOUS ? "Anonymous" : group);

export interface PermissionsTableProps<R extends TableRowOf<R>> {
  groups: readonly Group[];
  workflows: readonly R[];
  ops: readonly R[];
  /** A row's cell for the column at `groupIndex`; `under`, the workflow an operation is called in. */
  cell: (row: R, groupIndex: number, under: R | undefined, kind: Kind) => ReactNode;
  /** Whether a workflow's name links to its page; every one does when not given. */
  linkRow?: (row: R) => boolean;
}

/** The grid as a table: a heading per group, then the workflows' part and the direct operations', each under its heading. */
export function PermissionsTable<R extends TableRowOf<R>>({
  groups,
  workflows,
  ops,
  cell,
  linkRow,
}: PermissionsTableProps<R>) {
  const rows = { groups, cell, linkRow };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="sr-only">Workflow or operation</span>
          </TableHead>
          {groups.map((group) => (
            <TableHead key={group ?? ""} scope="col">
              {columnLabel(group)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <Rows kind="workflow" rows={workflows} {...rows} />
      <Rows kind="op" rows={ops} {...rows} />
    </Table>
  );
}

type RowsProps<R extends TableRowOf<R>> = Omit<PermissionsTableProps<R>, "workflows" | "ops"> & { kind: Kind };

/** A part of the grid under its heading: each row, and under a workflow's the operations it uses, indented. */
function Rows<R extends TableRowOf<R>>({ kind, rows, ...props }: RowsProps<R> & { rows: readonly R[] }) {
  if (rows.length === 0) return null;
  return (
    <TableBody>
      <TableRow className="bg-muted/50 hover:bg-muted/50">
        <TableHead colSpan={props.groups.length + 1} scope="colgroup">
          {kind === "workflow" ? "Starting a workflow, and the operations it calls" : "Calling an operation directly"}
        </TableHead>
      </TableRow>
      {rows.map((row) => (
        <Fragment key={row.id}>
          <Line kind={kind} row={row} {...props} />
          {row.ops?.map((op, i) => (
            // By position: a workflow may list an operation twice, as the run form asks it twice.
            <Line key={i} kind="op" row={op} under={row} {...props} />
          ))}
        </Fragment>
      ))}
    </TableBody>
  );
}

/** A row: its name (a workflow linking to its page, an operation in a workflow indented under it), then its cell for each group. */
function Line<R extends TableRowOf<R>>({
  kind,
  row,
  under,
  groups,
  cell,
  linkRow,
}: RowsProps<R> & { row: R; under?: R }) {
  return (
    <TableRow>
      <TableHead scope="row" className={cn("font-normal", under && "pl-8")}>
        {kind === "op" ? (
          <code>{row.id}</code>
        ) : (linkRow?.(row) ?? true) ? (
          <Link to="/workflows/$name" params={{ name: row.id }} className="hover:underline">
            {row.title ?? row.id}
          </Link>
        ) : (
          (row.title ?? row.id)
        )}
      </TableHead>
      {groups.map((group, i) => (
        <TableCell key={group ?? ""}>{cell(row, i, under, kind)}</TableCell>
      ))}
    </TableRow>
  );
}

/**
 * A cell: `allow` muted, else a badge in its tone (a hold naming whom it asks), a button when it
 * opens a rule (`what` names the cell for its label); every answer muted when `muted`.
 */
export function Mark({
  cell,
  what,
  open,
  muted = false,
}: {
  cell: PreviewAnswer;
  what?: string;
  open?: (() => void) | undefined;
  muted?: boolean;
}) {
  const label = answerWords(cell);
  if (muted || cell.answer === "allow") return <span className="text-muted-foreground">{label}</span>;
  const button = open && {
    render: <button type="button" />,
    onClick: open,
    "aria-label": `${label}: the rule for ${what}`,
  };
  return (
    <ToneBadge tone={PREVIEW_TONE[cell.answer]} {...button}>
      {label}
    </ToneBadge>
  );
}
