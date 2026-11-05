import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import { errorMessage, type Saved } from "@sanoma-ai/workflows/shared";
import { useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useHydrated, useNavigate } from "@tanstack/react-router";
import {
  type CellSelectionDirection,
  cellSelectionFeature,
  columnResizingFeature,
  columnSizingFeature,
  type ColumnSizingState,
  columnVisibilityFeature,
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { cn } from "#/lib/utils.ts";
import { errorBodyOf } from "../../api.ts";
import type { UntypedApi } from "../../api-client.ts";
import { fieldsOf, type ScalarField, type ScalarValue } from "../../form/schema.ts";
import {
  api,
  DATA_KEY,
  type DataSearch,
  heldQuery,
  type RecordCall,
  recordCallKey,
  toastIfHeld,
  useRecordCall,
} from "../../queries.ts";
import { Nothing, StatusDot, When } from "../common.tsx";
import { FROM, IssuesFlag, SortHead, Value } from "../data-grid.tsx";
import { CellEditor, draftOf, recordWith } from "./cell.tsx";
import { delimited } from "./clipboard.ts";
import { type Conflict, conflictId, ConflictRow } from "./conflicts.tsx";
import { typedCharacter, useGridKeys } from "./keys.ts";

// A collection's records as a spreadsheet: a column per field, in the collection's order, then
// when each record was saved and by whom. Click or arrow to a cell, type or press Enter to edit
// it, Enter to save it: one edit is one `save` of the record with `ifRecord`, the record as the
// grid read it, so a record someone changed since comes back as a conflict, never overwritten.
// The first page renders on the server as rows; the selection, the editors and the virtual rows
// mount in the browser. Sorting, filtering and hiding are the page's search (`DataSearch`).

const features = tableFeatures({
  cellSelectionFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
});
const column = createColumnHelper<typeof features, Saved>();

/** The columns after the fields, by ids no field can have. */
const UPDATED = "@updated";
const BY = "@by";
const HEADS: Record<string, string> = { [UPDATED]: "Updated", [BY]: "By" };

/** A row's height in pixels, which the virtual rows are laid out by. */
const ROW_PX = 37;

/** How tall the grid is in the browser before it measures itself: about 16 rows. */
const INITIAL_RECT = { width: 1200, height: 16 * ROW_PX };

/** A collection's column widths, in this browser: `localStorage` may refuse to be read or written. */
const widthsKey = (name: string) => `sanoma.grid.${name}.widths`;
function readWidths(name: string): ColumnSizingState {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(widthsKey(name)) ?? "{}");
    return typeof stored === "object" && stored !== null ? (stored as ColumnSizingState) : {};
  } catch {
    return {};
  }
}
function writeWidths(name: string, widths: ColumnSizingState) {
  try {
    localStorage.setItem(widthsKey(name), JSON.stringify(widths));
  } catch {
    // A private window, or storage turned off: the widths last as long as the page.
  }
}

/** The cell being edited, what its editor holds, and what it started with but a typed character. */
interface Editing {
  key: string;
  field: string;
  draft: ScalarValue;
  start: ScalarValue;
}

/** A cell a spreadsheet would read as a formula: written as text in a download. */
const FORMULA = /^[=+\-@\t\r]/;

/**
 * The grid: `records` as `list` read them for the page's search, `order` its sort, `open` the
 * record in the side panel, `hide` the fields left out, `people` the declared people's ids (what
 * a person field chooses from). Says how many match, or that there may be more than `limit`.
 */
export function DataGrid({
  collection,
  records,
  order,
  open,
  filtered,
  limit,
  hide,
  people,
}: {
  collection: CollectionEntry;
  records: Saved[];
  order: string | undefined;
  /** The key of the record open in the side panel. */
  open: string | undefined;
  filtered: boolean;
  limit: number;
  hide: string[] | undefined;
  people: readonly string[];
}) {
  const { name, key: keyField } = collection;
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: FROM });
  const hydrated = useHydrated();
  const fields = useMemo(
    () =>
      new Map(
        (fieldsOf(collection.record) ?? []).flatMap((f) =>
          f.kind === "object" || f.kind === "array" ? [] : [[f.key, f] as const],
        ),
      ),
    [collection.record],
  );
  const columns = useMemo(
    () =>
      column.columns([
        ...Object.keys(collection.fields).map((field) =>
          column.accessor((saved) => saved.record[field], {
            id: field,
            header: field,
            size: field === keyField ? 200 : 160,
          }),
        ),
        column.accessor((saved) => saved.updatedAt, { id: UPDATED, header: HEADS[UPDATED], size: 130 }),
        column.accessor((saved) => saved.updatedBy, { id: BY, header: HEADS[BY], size: 110 }),
      ]),
    [collection.fields, keyField],
  );
  // Never the key: it names each row, and opens its record.
  const columnVisibility = useMemo(
    () => Object.fromEntries((hide ?? []).filter((f) => f !== keyField).map((f) => [f, false])),
    [hide, keyField],
  );
  // The widths are this browser's: read once it has hydrated, so the server's page is the browser's first.
  const [widths, setWidths] = useState<ColumnSizingState>({});
  useEffect(() => setWidths(readWidths(name)), [name]);
  const table = useTable({
    features,
    columns,
    data: records,
    getRowId: (saved) => saved.key,
    state: { columnVisibility, columnSizing: widths },
    onColumnSizingChange: setWidths,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 60, maxSize: 800 },
    // A save reads the records again: the selection stays where it was.
    autoResetCellSelection: false,
  });
  const resizing = table.state.columnResizing.isResizingColumn !== false;
  useEffect(() => {
    if (!resizing && Object.keys(widths).length) writeWidths(name, widths);
  }, [name, widths, resizing]);

  const call = useRecordCall(name);
  // What is being saved, by key: shown in its cells until the save settles (then the records
  // read again show it), so a denied or held save reverts to the record as it is.
  const saving = useMutationState({
    filters: { mutationKey: recordCallKey(name), status: "pending" },
    select: (mutation) => mutation.state.variables as RecordCall | undefined,
  });
  const savingRecords = new Map(
    saving.flatMap((variables) => {
      const record =
        variables?.op === "save" ? (variables.input as { record: Record<string, unknown> }).record : undefined;
      return record ? [[String(record[keyField]), record] as const] : [];
    }),
  );
  const held = useQuery(heldQuery(collection)).data;
  // Once a held save's run ends (approved, or not), its record is read again.
  const wasHeld = useRef<string[]>(undefined);
  useEffect(() => {
    if (wasHeld.current?.some((k) => !held?.includes(k)))
      void queryClient.invalidateQueries({ queryKey: [...DATA_KEY, name] });
    wasHeld.current = held;
  }, [held, name, queryClient]);
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, Conflict>>(new Map());
  const dropConflict = (conflict: Conflict) =>
    setConflicts((all) => {
      const next = new Map(all);
      next.delete(conflictId(conflict));
      return next;
    });
  const [savedAt, setSavedAt] = useState<number>();
  // By key, the record as its last save in flight leaves it (undefined once it fails): an edit
  // made meanwhile saves over that, not over the rows read before it, so it is never a conflict
  // with your own edit.
  const lastSave = useRef(new Map<string, Promise<Record<string, unknown> | undefined>>());

  /**
   * Saves `record` over `ifRecord`, the one cell `field` of `key` edited; Undo saves `ifRecord`
   * back. Answers the record as saved, or undefined when it was not.
   */
  async function save(
    key: string,
    field: string,
    record: Record<string, unknown>,
    ifRecord: Record<string, unknown>,
    undoing = false,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const saved = (await call.mutateAsync({ op: "save", input: { record, ifRecord } })) as Saved;
      setSavedAt(Date.parse(saved.updatedAt));
      if (undoing) toast.success(`Undid ${field} for ${key}`);
      else
        toast.success(`Saved ${field} for ${key}`, {
          action: { label: "Undo", onClick: () => void save(key, field, ifRecord, saved.record, true) },
        });
      return saved.record;
    } catch (err) {
      if (toastIfHeld(err)) return undefined;
      const body = errorBodyOf(err);
      if (body?.code === "record_changed") {
        const conflict = { key, field, mine: record[field], current: body.current };
        setConflicts((all) => new Map(all).set(conflictId(conflict), conflict));
        return undefined;
      }
      // A denial says the policy's reason; the cell shows the record as it is again.
      toast.error(`Could not save ${field} for ${key}`, { description: errorMessage(err) });
      return undefined;
    }
  }

  /** Use mine: what you typed over the record as it is now, read again when the conflict did not say. */
  async function takeMine(conflict: Conflict) {
    let current = conflict.current;
    if (current === undefined) {
      try {
        current = (await (api as UntypedApi).data[name].get({ key: conflict.key })) as Saved | null;
      } catch (err) {
        // The conflict stays, and what you typed with it.
        return void toast.error(`Could not read ${conflict.key}`, { description: errorMessage(err) });
      }
    }
    dropConflict(conflict);
    if (!current) {
      toast.error(`${conflict.key} is gone`, { description: "Someone else deleted the record." });
      return void queryClient.invalidateQueries({ queryKey: [...DATA_KEY, name] });
    }
    const { [conflict.field]: _, ...rest } = current.record;
    const record = conflict.mine === undefined ? rest : { ...rest, [conflict.field]: conflict.mine };
    await save(conflict.key, conflict.field, record, current.record);
  }

  const keepTheirs = (conflict: Conflict) => {
    dropConflict(conflict);
    void queryClient.invalidateQueries({ queryKey: [...DATA_KEY, name] });
  };

  const [editing, setEditingState] = useState<Editing | null>(null);
  // The edit as it is now, for an end that comes from an editor's last render: its blur as it
  // unmounts after Enter must not save it twice.
  const editingNow = useRef<Editing | null>(null);
  const setEditing = (next: Editing | null) => {
    editingNow.current = next;
    setEditingState(next);
  };
  // Set while an edit ends from the keyboard: the cell takes the focus back from its editor.
  const refocus = useRef(false);
  const [grid, setGrid] = useState<HTMLTableElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const focused = table.getFocusedCell();
  const focusedField = focused && fields.get(focused.column.id);
  /** The field the focused cell edits: none for the key, Updated and By, or a field the form cannot hold. */
  const editable = focusedField && focusedField.key !== keyField ? focusedField : undefined;

  const startEditing = (typed?: string) => {
    if (!focused || !editable) return;
    const saved = focused.row.original;
    const value = (savingRecords.get(saved.key) ?? saved.record)[editable.key];
    const start = draftOf(editable, value, undefined, people);
    const draft = typed === undefined ? start : draftOf(editable, value, typed, people);
    // At once, so the editor has the focus before the next key arrives.
    flushSync(() => setEditing({ key: saved.key, field: editable.key, draft, start }));
  };

  const commit = (then?: CellSelectionDirection, fromKeyboard = true) => {
    const edit = editingNow.current;
    if (!edit) return;
    const field = fields.get(edit.field) as ScalarField;
    const row = rows.find((r) => r.id === edit.key);
    refocus.current = fromKeyboard;
    setEditing(null);
    if (then) table.moveCellSelection(then);
    // Left as it opened: never a save, even of a value the editor cannot hold (an enum's value
    // its options no longer have), which it would drop.
    if (!row || edit.draft === edit.start) return;
    const checked = recordWith(field, row.original.record, edit.draft);
    if ("error" in checked) return void toast.error(`${edit.field}: ${checked.error}`);
    const prior = lastSave.current.get(edit.key);
    const queued = (async () => {
      const base = (await prior) ?? row.original.record;
      const next = recordWith(field, base, edit.draft);
      if ("error" in next || JSON.stringify(next.record) === JSON.stringify(base)) return base;
      return save(edit.key, edit.field, next.record, base);
    })();
    lastSave.current.set(edit.key, queued);
    void queued.finally(() => {
      if (lastSave.current.get(edit.key) === queued) lastSave.current.delete(edit.key);
    });
  };

  useGridKeys(grid, {
    editing: editing !== null,
    move: (direction) => {
      const before = table.getFocusedCell()?.id;
      table.moveCellSelection(direction);
      return table.getFocusedCell()?.id !== before;
    },
    extend: (direction) => table.extendCellSelection(direction),
    edit: () => startEditing(),
    commit,
    cancel: () => {
      refocus.current = true;
      setEditing(null);
    },
    expand: () => {
      if (focused)
        void navigate({ search: (prev) => ({ ...prev, record: focused.row.id, new: undefined }), resetScroll: false });
    },
    copy: () => {
      const [range] = table.getSelectedCellRangesData();
      if (!range) return;
      const text = delimited(range, "\t");
      // No clipboard on a page served over plain HTTP, or one the browser refuses: say so.
      void Promise.resolve()
        .then(() => navigator.clipboard.writeText(text))
        .catch(() => toast.error("Could not copy the cells"));
    },
  });

  // The focused cell has the focus while the grid has it, or when an edit ends from the keyboard.
  const focusedId = focused?.id;
  useEffect(() => {
    if (!grid || !focusedId || editing) return;
    if (!refocus.current && !grid.contains(document.activeElement)) return;
    refocus.current = false;
    grid.querySelector<HTMLElement>(`[data-cell="${CSS.escape(focusedId)}"]`)?.focus();
  }, [grid, focusedId, editing]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_PX,
    getItemKey: (index) => rows[index]!.id,
    overscan: 12,
    initialRect: INITIAL_RECT,
  });
  // On the server, and as the browser hydrates, every row of the page; then only those in view.
  const items = hydrated ? virtualizer.getVirtualItems() : rows.map((_, index) => ({ index, start: index * ROW_PX }));
  const before = hydrated ? (items[0]?.start ?? 0) : 0;
  const after = hydrated ? virtualizer.getTotalSize() - (items.length ? items.at(-1)!.start + ROW_PX : 0) : 0;
  const visible = table.getVisibleLeafColumns();

  if (records.length === 0) {
    return (
      <Nothing title={filtered ? "No record matches" : "No records yet"}>
        {filtered ? "Change the filters to see others." : "Add one, or save one from a workflow."}
      </Nothing>
    );
  }

  const exportCsv = () => {
    const heads = visible.map((c) => HEADS[c.id] ?? c.id);
    const values = rows.map((row) =>
      row.getVisibleCells().map((cell) => {
        const value = cell.getValue();
        return typeof value === "string" && FORMULA.test(value) ? `'${value}` : value;
      }),
    );
    const url = URL.createObjectURL(new Blob([delimited([heads, ...values], ",")], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${name}.csv` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url));
  };

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border">
      <div ref={scroller} className="max-h-[min(70vh,48rem)] overflow-auto">
        <table
          ref={setGrid}
          role="grid"
          aria-label={collection.title ?? name}
          aria-rowcount={rows.length + 1}
          aria-colcount={visible.length}
          data-slot="table"
          className="table-fixed border-separate border-spacing-0 text-sm"
          style={{ width: table.getTotalSize() }}
          onKeyDown={(event: KeyboardEvent) => {
            // On a cell itself: not its link, nor an editor.
            const typed = editing ? undefined : typedCharacter(event);
            if (typed === undefined || !editable || (event.target as HTMLElement).dataset.cell === undefined) return;
            event.preventDefault();
            startEditing(typed);
          }}
        >
          <TableHeader>
            <TableRow aria-rowindex={1} className="hover:bg-transparent">
              {table.getFlatHeaders().map((header) => {
                if (!header.column.getIsVisible()) return null;
                const head = {
                  style: { width: header.getSize() },
                  className: "sticky top-0 z-10 border-b bg-background",
                  children: (
                    <div
                      aria-hidden
                      data-resizing={header.column.getIsResizing() || undefined}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-border data-resizing:bg-ring"
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                    />
                  ),
                };
                return HEADS[header.id] ? (
                  <TableHead key={header.id} {...head}>
                    {HEADS[header.id]}
                    {head.children}
                  </TableHead>
                ) : (
                  <SortHead key={header.id} field={header.id} order={order} {...head} />
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {before > 0 && (
              <tr aria-hidden>
                <td colSpan={visible.length} style={{ height: before }} />
              </tr>
            )}
            {items.map(({ index }) => {
              const row = rows[index]!;
              const saved = row.original;
              const shown = savingRecords.get(saved.key) ?? saved.record;
              const rowConflicts = [...conflicts.values()].filter((c) => c.key === saved.key);
              return [
                <TableRow
                  key={row.id}
                  aria-rowindex={index + 2}
                  data-state={saved.key === open ? "selected" : undefined}
                  className="hover:bg-transparent"
                >
                  {row.getVisibleCells().map((cell, c) => {
                    const id = cell.column.id;
                    const field = fields.get(id);
                    const conflict = conflicts.get(conflictId({ key: saved.key, field: id }));
                    const isEditing = editing?.key === saved.key && editing.field === id && field;
                    // Before anything is focused, the first cell is the grid's one stop for Tab.
                    const tabIndex = !focused && index === 0 && c === 0 ? 0 : cell.getTabIndex();
                    return (
                      <TableCell
                        key={cell.id}
                        data-cell={cell.id}
                        tabIndex={tabIndex}
                        aria-selected={cell.getIsSelected()}
                        aria-invalid={conflict ? true : undefined}
                        style={{ width: cell.column.getSize() }}
                        className={cn(
                          "h-9 truncate border-b px-2 py-0 outline-none select-none",
                          id === keyField && "font-medium",
                          (id === UPDATED || id === BY) && "text-muted-foreground",
                          cell.getIsSelected() && "bg-primary/5",
                          conflict && "bg-tone-waiting text-tone-waiting-foreground",
                          cell.getIsFocused() && "shadow-[inset_0_0_0_2px_var(--color-ring)]",
                          isEditing && "px-0.5",
                        )}
                        onFocus={(e) => {
                          if (e.target === e.currentTarget && !cell.getIsFocused()) table.setFocusedCell(row.id, id);
                        }}
                        onMouseDown={isEditing ? undefined : cell.getSelectionStartHandler()}
                        onMouseEnter={cell.getSelectionExtendHandler()}
                        onDoubleClick={() => startEditing()}
                      >
                        {isEditing ? (
                          <CellEditor
                            field={field}
                            draft={editing.draft}
                            people={people}
                            label={`${id} of ${saved.key}`}
                            onDraft={(draft) => setEditing({ ...editing, draft })}
                            onBlur={() => commit(undefined, false)}
                          />
                        ) : id === keyField ? (
                          <span className="flex items-center gap-2">
                            <Link
                              to={FROM}
                              params={{ name }}
                              search={(prev: DataSearch) => ({ ...prev, record: saved.key, new: undefined })}
                              resetScroll={false}
                              preload={false}
                              tabIndex={-1}
                              className="truncate underline-offset-4 hover:underline"
                            >
                              {saved.key}
                            </Link>
                            {saved.issues && <IssuesFlag issues={saved.issues} />}
                            {held?.includes(saved.key) && (
                              <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
                                <span
                                  aria-hidden
                                  className="size-2.5 rounded-full border-2 border-tone-waiting-foreground"
                                />
                                waits for approval
                              </span>
                            )}
                          </span>
                        ) : id === UPDATED ? (
                          <When at={Date.parse(saved.updatedAt)} />
                        ) : id === BY ? (
                          saved.updatedBy
                        ) : (
                          <Value value={conflict ? conflict.mine : shown[id]} />
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>,
                rowConflicts.length > 0 && (
                  <ConflictRow
                    key={`${row.id}:conflicts`}
                    conflicts={rowConflicts}
                    columns={visible.length}
                    onKeep={keepTheirs}
                    onUseMine={(conflict) => void takeMine(conflict)}
                  />
                ),
              ];
            })}
            {after > 0 && (
              <tr aria-hidden>
                <td colSpan={visible.length} style={{ height: after }} />
              </tr>
            )}
          </TableBody>
        </table>
      </div>
      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
        <span>
          {records.length >= limit
            ? `The first ${limit} records: filter them, or show more, to see the rest`
            : records.length === 1
              ? "1 record matches"
              : `${records.length} records match`}
        </span>
        {savedAt !== undefined && (
          <>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-1.5">
              Saved <StatusDot tone="ok" className="size-1.5" /> <When at={savedAt} />
            </span>
          </>
        )}
        <span className="ml-auto" role="status">
          {focused &&
            `Row ${rows.findIndex((r) => r.id === focused.row.id) + 1}, ${HEADS[focused.column.id] ?? focused.column.id}`}
          {focused && editable && (editing ? " · Enter to save · Esc to cancel" : " · Enter to change")}
          {focused && !editing && " · Space expands"}
        </span>
        <Button variant="ghost" size="sm" onClick={exportCsv}>
          <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
          Export CSV
        </Button>
      </footer>
    </div>
  );
}
