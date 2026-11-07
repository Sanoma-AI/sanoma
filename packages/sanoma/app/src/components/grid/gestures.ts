import type { Saved } from "sanoma/workflows/shared";
import { useEffect, useState } from "react";
import type { ScalarField } from "../../form/schema.ts";
import { plural } from "../../lib/utils.ts";
import { valueOf } from "./cell.tsx";
import { cellsOf, cellText } from "./clipboard.ts";
import { type CellChange, isNew, newKey, type Step } from "./collection.ts";
import type { GridTable } from "./grid.tsx";
import type { RecordChange } from "./staged.tsx";

// The grid's gestures that stage instead of saving, read off the table's selection: a paste, the
// fill handle, Delete and Shift+Enter, each one `Step` of the change (`collection.ts`'s `stage`),
// so Cmd/Ctrl+Z takes it back whole. Each cell's text is read as its field reads it (`valueOf`),
// a text it cannot read kept with why, so the cell shows what was typed until it is fixed.

/** The indexes from `from` to `to`, both included. */
const span = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/**
 * The gestures over `table`: `fields` the ones a cell can hold, `changeOfKey` each staged
 * record's change (a record staged to be deleted takes no other), `stage` what each gesture's
 * step goes to.
 */
export function useGestures({
  table,
  fields,
  keyField,
  changeOfKey,
  stage,
}: {
  table: GridTable;
  fields: ReadonlyMap<string, ScalarField>;
  keyField: string;
  changeOfKey: ReadonlyMap<string, RecordChange>;
  stage: (step: Step) => boolean;
}) {
  const rows = table.getRowModel().rows;
  const visible = table.getVisibleLeafColumns();
  const focused = table.getFocusedCell();

  /** Whether a gesture changes `saved`'s cell `id`: a field the form holds, a new record's key too, never a record staged to be deleted. */
  const changeable = (saved: Saved, id: string) =>
    fields.has(id) && (id !== keyField || isNew(saved.key)) && changeOfKey.get(saved.key)?.type !== "delete";

  /** The change of `saved`'s cell `id` to `text`, read as its field reads it; none where no gesture changes it, or it holds that already. */
  const changeOf = (saved: Saved, id: string, text: string): CellChange[] => {
    const field = fields.get(id);
    if (!field || !changeable(saved, id)) return [];
    const read = valueOf(field, text);
    if ("error" in read) return [{ key: saved.key, field: id, value: text, error: read.error }];
    return read.value === saved.record[id] ? [] : [{ key: saved.key, field: id, value: read.value }];
  };

  /** The selected cells, each its row's record and its column. */
  const selectedCells = () =>
    table.getCellSelectionBounds().flatMap((bounds) =>
      span(bounds.minRowIndex, bounds.maxRowIndex).flatMap((r) =>
        span(bounds.minColumnIndex, bounds.maxColumnIndex).flatMap((c) => {
          const saved = rows[r]?.original;
          const id = visible[c]?.id;
          return saved && id ? [{ saved, id }] : [];
        }),
      ),
    );

  /**
   * Pastes `text` (tab-separated, as spreadsheets copy a range) from the focused cell: over the
   * rows there, and as new records past the last; one value into a selection fills it.
   */
  const paste = (text: string) => {
    const pasted = cellsOf(text, "\t");
    if (!focused || pasted.length === 0) return;
    const [only] = pasted.length === 1 && pasted[0]!.length === 1 ? pasted[0]! : [];
    if (only !== undefined && table.getSelectedCellCount() > 1) {
      const cells = selectedCells().flatMap(({ saved, id }) => changeOf(saved, id, only));
      return stage({ what: "paste", said: `Pasted into ${plural(cells.length, "cell")}`, cells });
    }
    const top = focused.row.getDisplayIndex();
    const left = visible.findIndex((c) => c.id === focused.column.id);
    const width = Math.min(Math.max(...pasted.map((line) => line.length)), visible.length - left);
    // Past the last row, each line a new record, staged (`newKey`).
    const lines = pasted.map((line, i) => {
      const row = rows[top + i]?.original;
      return { line, added: !row, saved: row ?? { key: newKey(), record: {}, updatedAt: "", updatedBy: "" } };
    });
    const adds = lines.flatMap(({ added, saved }) => (added ? [saved.key] : []));
    const staged = stage({
      what: "paste",
      said: `Pasted ${plural(pasted.length, "row")} × ${plural(width, "column")} at row ${top + 1}, ${focused.column.id}`,
      adds,
      cells: lines.flatMap(({ line, saved }) =>
        line.slice(0, width).flatMap((value, j) => changeOf(saved, visible[left + j]!.id, value)),
      ),
    });
    // A paste refused leaves no new rows to select.
    if (!staged && adds.length > 0) return;
    // What was pasted is the selection.
    table.selectCellRange({
      anchorRowId: focused.row.id,
      anchorColumnId: focused.column.id,
      focusRowId: lines.at(-1)!.saved.key,
      focusColumnId: visible[left + width - 1]!.id,
    });
  };

  // The selection's one range, which the fill handle drags down from its bottom-right corner;
  // while it drags, the last row it fills.
  const ranges = table.getCellSelectionBounds();
  const fillFrom = ranges.length === 1 ? ranges[0] : undefined;
  const [fillTo, setFillTo] = useState<number>();
  /** Fills the rows under the selection down to `to`, repeating its rows' values, as spreadsheets do. */
  const fill = (to: number) => {
    if (!fillFrom || to <= fillFrom.maxRowIndex) return;
    const height = fillFrom.maxRowIndex - fillFrom.minRowIndex + 1;
    const cells = span(fillFrom.maxRowIndex + 1, to).flatMap((r) =>
      span(fillFrom.minColumnIndex, fillFrom.maxColumnIndex).flatMap((c) => {
        const id = visible[c]!.id;
        const source = rows[fillFrom.minRowIndex + ((r - fillFrom.maxRowIndex - 1) % height)]!.original;
        return changeOf(rows[r]!.original, id, cellText(source.record[id]));
      }),
    );
    stage({
      what: "fill",
      said: `Filled ${plural(to - fillFrom.maxRowIndex, "row")} down from row ${fillFrom.maxRowIndex + 1}`,
      cells,
    });
    table.selectCellRange({
      anchorRowId: rows[fillFrom.minRowIndex]!.id,
      anchorColumnId: visible[fillFrom.minColumnIndex]!.id,
      focusRowId: rows[to]!.id,
      focusColumnId: visible[fillFrom.maxColumnIndex]!.id,
    });
  };
  // A drag of the fill handle ends where the mouse is let go, in the grid or not.
  useEffect(() => {
    if (fillTo === undefined) return;
    const end = () => {
      setFillTo(undefined);
      fill(fillTo);
    };
    document.addEventListener("mouseup", end, { once: true });
    return () => document.removeEventListener("mouseup", end);
  });

  /** Delete: clears the selected cells, and deletes the records whose key is among them. */
  const clear = () => {
    const cells = selectedCells();
    const deletes = new Set(
      cells.flatMap(({ saved, id }) =>
        id === keyField && changeOfKey.get(saved.key)?.type !== "delete" ? [saved.key] : [],
      ),
    );
    const cleared = cells.flatMap(({ saved, id }) => (deletes.has(saved.key) ? [] : changeOf(saved, id, "")));
    stage({
      what: "delete",
      said: deletes.size ? `Deleted ${plural(deletes.size, "record")}` : `Cleared ${plural(cleared.length, "cell")}`,
      cells: cleared,
      deletes: [...deletes],
    });
  };

  /** Shift+Enter: a new record below the rows, its key cell focused. */
  const addRecord = () => {
    const key = newKey();
    if (stage({ what: "new record", said: "Added a record", adds: [key] })) table.setFocusedCell(key, keyField);
  };

  return { changeable, changeOf, selectedCells, paste, fillFrom, fillTo, setFillTo, clear, addRecord };
}
