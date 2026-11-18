import type { PreviewAnswer } from "sanoma/workflows";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { answerWords, columnLabel, type Group } from "#/lib/grid-diff.ts";
import { isCompanyOp, operationName } from "#/lib/operations.ts";
import { PREVIEW_TONE } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import { ToneBadge } from "./kit.tsx";

// The Permissions grid's table, the Permissions page's and a change's diff of it (permissions-diff.tsx):
// groups across, each workflow's start with the operations it calls under it and each direct
// operation down, a company operation's calls under it, and what goes in a cell the caller's.

/** What a row is about: a workflow's start, or an operation, called in a workflow or directly. */
export type Kind = "workflow" | "op";
/**
 * A row of the table: an id, a title (a workflow's), and under a workflow the operations it uses,
 * under a company operation the calls inside it.
 */
export interface TableRowOf<R> {
  id: string;
  title?: string;
  ops?: R[];
}

export interface PermissionsTableProps<R extends TableRowOf<R>> {
  groups: readonly Group[];
  workflows: readonly R[];
  ops: readonly R[];
  /** A row's cell for the column at `groupIndex`; `under`, the row it is under (a workflow, a company operation). */
  cell: (row: R, groupIndex: number, under: R | undefined, kind: Kind) => ReactNode;
  /** Whether a workflow's name, or a company operation's, links to its page; every one does when not given. */
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
  const shared = { groups, cell, linkRow };
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
      <Rows kind="workflow" rows={workflows} {...shared} />
      <Rows kind="op" rows={ops} {...shared} />
    </Table>
  );
}

type RowsProps<R extends TableRowOf<R>> = Omit<PermissionsTableProps<R>, "workflows" | "ops"> & { kind: Kind };

/** A part of the grid under its heading: each row, and under it, indented a step further each level, the rows it holds. */
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
        <Lines key={row.id} kind={kind} row={row} depth={0} {...props} />
      ))}
    </TableBody>
  );
}

/** How far a row is indented, by how many rows it is under: a workflow's operation, then a company operation's call. */
const INDENT = ["", "pl-8", "pl-14"];

/** A row, then the rows under it (a workflow's operations, a company operation's calls), one level deeper. */
function Lines<R extends TableRowOf<R>>({
  row,
  under,
  depth,
  ...props
}: RowsProps<R> & { row: R; under?: R; depth: number }) {
  return (
    <>
      <Line row={row} under={under} depth={depth} {...props} />
      {row.ops?.map((op, i) => (
        // By position: a workflow may list an operation twice, as the run form asks it twice.
        <Lines key={i} {...props} kind="op" row={op} under={row} depth={depth + 1} />
      ))}
    </>
  );
}

/**
 * A row: its name (a workflow linking to its page, a company operation to its own, an operation
 * under a row indented under it), then its cell for each group. A direct operation's row is the
 * target of a link to its id (`#<id>`).
 */
function Line<R extends TableRowOf<R>>({
  kind,
  row,
  under,
  depth,
  groups,
  cell,
  linkRow,
}: RowsProps<R> & { row: R; under: R | undefined; depth: number }) {
  const linked = linkRow?.(row) ?? true;
  const own = isCompanyOp(row.id);
  return (
    <TableRow id={kind === "op" && depth === 0 ? row.id : undefined}>
      <TableHead scope="row" className={cn("font-normal", INDENT[depth])}>
        {kind === "op" ? (
          own && linked ? (
            <Link
              to="/connectors/operations/$name"
              params={{ name: operationName(row.id) }}
              className="hover:underline"
            >
              <code>{row.id}</code>
            </Link>
          ) : (
            <code>{row.id}</code>
          )
        ) : linked ? (
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
 * opens a rule (`what` names the cell for its label).
 */
export function Mark({ cell, what, open }: { cell: PreviewAnswer; what: string; open: (() => void) | undefined }) {
  const label = answerWords(cell);
  if (cell.answer === "allow") return <span className="text-muted-foreground">{label}</span>;
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
