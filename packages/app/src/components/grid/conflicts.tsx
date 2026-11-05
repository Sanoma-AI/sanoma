import type { Saved } from "@sanoma-ai/workflows/shared";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Button } from "#/components/ui/button.tsx";
import { TableCell, TableRow } from "#/components/ui/table.tsx";
import { When } from "../common.tsx";
import { cellText } from "./clipboard.ts";

// A cell whose save found its record changed since the grid read it (`record_changed`): the
// grid never writes over someone else's change. The cell shows what you typed, in the waiting
// tone, and a row under the record's says what is there now and asks which stands.

/** A cell's save the record's change refused: what you typed, and the record as it is now, when told. */
export interface Conflict {
  key: string;
  field: string;
  mine: unknown;
  /** The record as it stands, when the runtime said; null once it is gone. */
  current?: Saved | null | undefined;
}

/** A conflict's cell, as the grid keys its cells. */
export const conflictId = ({ key, field }: Pick<Conflict, "key" | "field">) => `${key}\u0000${field}`;

/** What happened to the record since: who set the field to what, and when, when the runtime said. */
function Theirs({ conflict: { field, current } }: { conflict: Conflict }) {
  if (current === null) return <>Someone else deleted this record.</>;
  if (current === undefined) return <>Someone else changed this record.</>;
  const value = cellText(current.record[field]);
  return (
    <>
      {current.updatedBy} set {value === "" ? "nothing" : <strong className="font-medium">{value}</strong>}{" "}
      <When at={Date.parse(current.updatedAt)} />.
    </>
  );
}

/**
 * The row under a record's with its cells' conflicts, across the grid: each field, what is
 * there now, and Keep theirs (drop what you typed) or Use mine (save it over theirs).
 */
export function ConflictRow({
  conflicts,
  columns,
  onKeep,
  onUseMine,
}: {
  conflicts: Conflict[];
  columns: number;
  onKeep: (conflict: Conflict) => void;
  onUseMine: (conflict: Conflict) => void;
}) {
  return (
    <TableRow className="bg-tone-waiting hover:bg-tone-waiting">
      <TableCell colSpan={columns} className="sticky left-0 whitespace-normal text-tone-waiting-foreground">
        <ul className="flex flex-col gap-2">
          {conflicts.map((conflict) => (
            <li key={conflict.field} role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <WarningIcon aria-hidden="true" className="size-4 shrink-0" />
              <span>
                <code>{conflict.field}</code> changed since you read it: <Theirs conflict={conflict} />
              </span>
              <span className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => onKeep(conflict)}>
                  Keep theirs
                </Button>
                {conflict.current !== null && (
                  <Button size="sm" onClick={() => onUseMine(conflict)}>
                    Use mine
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </TableCell>
    </TableRow>
  );
}
