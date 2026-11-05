import type { CollectionEntry } from "@sanoma-ai/workflows/describe";
import { errorMessage, type Saved } from "@sanoma-ai/workflows/shared";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
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
import { api, type DataSearch, heldQuery } from "../../queries.ts";
import { Nothing, StatusDot, When } from "../common.tsx";
import { FROM, IssuesFlag, SortHead, Value } from "../data-grid.tsx";
import { CellEditor, draftOf, recordWith, withValue } from "./cell.tsx";
import { csv, delimited } from "./clipboard.ts";
import { type RecordsView, savedIn } from "./collection.ts";
import { type Conflict, conflictId, ConflictRow } from "./conflicts.tsx";
import { typedCharacter, useGridKeys } from "./keys.ts";

// A collection's records as a spreadsheet: a column per field, in the collection's order, then
// when each record was saved and by whom. Click or arrow to a cell, type or press Enter to edit
// it, Enter to save it: one edit is an optimistic update of the page's records collection
// (`collection.ts`), saved with `ifRecord`, the record as the edit found it, so a record someone
// changed since comes back as a conflict, never overwritten. The first page renders on the
// server as rows; the selection, the editors and the virtual rows mount in the browser.
// Sorting, filtering and hiding are the page's search (`DataSearch`).

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

/**
 * The grid: `view` the records `list` read for the page's search, `order` its sort, `open` the
 * record in the side panel, `hide` the fields left out, `people` the declared people's ids (what
 * a person field chooses from). Says how many match, or that there may be more than `limit`.
 */
export function DataGrid({
  collection,
  view: { collection: records, edit },
  order,
  open,
  filtered,
  limit,
  hide,
  people,
}: {
  collection: CollectionEntry;
  view: RecordsView;
  order: string | undefined;
  /** The key of the record open in the side panel. */
  open: string | undefined;
  filtered: boolean;
  limit: number;
  hide: string[] | undefined;
  people: readonly string[];
}) {
  const { name, key: keyField } = collection;
  // In the order `list` read them: by the sorted field, records without it last, then by key,
  // text as Postgres orders it under `COLLATE "C"`.
  const sortField = order?.replace(/^-/, "");
  const listed = useLiveQuery({
    query: (q) => {
      const from = q.from({ saved: records });
      const sorted = sortField
        ? from.orderBy(({ saved }) => saved.record[sortField], {
            direction: order?.startsWith("-") ? "desc" : "asc",
            nulls: "last",
            stringSort: "lexical",
          })
        : from;
      return sorted.orderBy(({ saved }) => saved.key, { direction: "asc", stringSort: "lexical" });
    },
  }).data;
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
    data: listed,
    getRowId: (saved) => saved.key,
    state: { columnVisibility, columnSizing: widths },
    onColumnSizingChange: setWidths,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 60, maxSize: 800 },
    // An edit changes the rows: the selection stays where it was.
    autoResetCellSelection: false,
  });
  const resizing = table.state.columnResizing.isResizingColumn !== false;
  useEffect(() => {
    if (!resizing && Object.keys(widths).length) writeWidths(name, widths);
  }, [name, widths, resizing]);

  // Built once per collection: a new `select` would run again over the waiting runs every render.
  const held = useQuery(useMemo(() => heldQuery({ name, key: keyField }), [name, keyField])).data;
  // Once a held save's run ends (approved, or not), the records are read again.
  const wasHeld = useRef<string[]>(undefined);
  useEffect(() => {
    if (wasHeld.current?.some((k) => !held?.includes(k))) void records.utils.refetch();
    wasHeld.current = held;
  }, [held, records]);
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, Conflict>>(new Map());
  const dropConflict = (conflict: Conflict) =>
    setConflicts((all) => {
      const next = new Map(all);
      next.delete(conflictId(conflict));
      return next;
    });
  const [savedAt, setSavedAt] = useState<number>();

  /**
   * Edits `key`'s record to `record`, the one cell `field` changed, after the grid's edits before
   * it; Undo edits it back. A refusal rolls the cell back: a conflict shows under the row, a
   * denial says why. A held edit's toast is the collection's.
   */
  function save(key: string, field: string, record: Record<string, unknown>, undoing = false) {
    // The field as the edit finds it, which Undo puts back.
    const before = records.get(key)?.record[field];
    const tx = edit({ key, record });
    // The record as it was: nothing to save.
    if (tx.mutations.length === 0) return;
    tx.when("settled").then(
      () => {
        const saved = savedIn(tx, key);
        // Held for an approval: its toast said so.
        if (!saved) return;
        setSavedAt(Date.parse(saved.updatedAt));
        if (undoing) toast.success(`Undid ${field} for ${key}`);
        else
          toast.success(`Saved ${field} for ${key}`, {
            // The one field back, over the record as it is now: edits since to its other fields stay.
            action: {
              label: "Undo",
              onClick: () => {
                const now = records.get(key);
                if (now) save(key, field, withValue(now.record, field, before), true);
              },
            },
          });
      },
      (err: unknown) => {
        const body = errorBodyOf(err);
        if (body?.code === "record_changed") {
          const conflict = { key, field, mine: record[field], current: body.current };
          setConflicts((all) => new Map(all).set(conflictId(conflict), conflict));
          return;
        }
        // A denial says the policy's reason; an edit made on one refused is rolled back with it.
        toast.error(`Could not save ${field} for ${key}`, {
          description: err === undefined ? "A change before it was not saved." : errorMessage(err),
        });
      },
    );
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
    if (!current) {
      toast.error(`${conflict.key} is gone`, { description: "Someone else deleted the record." });
      return keepTheirs(conflict);
    }
    dropConflict(conflict);
    // The record as it is now is what the edit is saved over (`ifRecord`).
    await records.utils.writeUpsert(current);
    save(conflict.key, conflict.field, withValue(current.record, conflict.field, conflict.mine));
  }

  const keepTheirs = (conflict: Conflict) => {
    dropConflict(conflict);
    void records.utils.refetch();
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
  // The keys' element: the cells' body, so a heading's sort link keeps Tab, the arrows and Space.
  const [body, setBody] = useState<HTMLTableSectionElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const focused = table.getFocusedCell();
  const focusedField = focused && fields.get(focused.column.id);
  /** The field the focused cell edits: none for the key, Updated and By, or a field the form cannot hold. */
  const editable = focusedField && focusedField.key !== keyField ? focusedField : undefined;

  const startEditing = (typed?: string) => {
    if (!focused || !editable) return;
    const saved = focused.row.original;
    const value = saved.record[editable.key];
    const start = draftOf(editable, value, undefined, people);
    const draft = draftOf(editable, value, typed, people);
    // At once, so the editor has the focus before the next key arrives.
    flushSync(() => setEditing({ key: saved.key, field: editable.key, draft, start }));
  };

  const commit = (then?: CellSelectionDirection, fromKeyboard = true) => {
    const cell = editingNow.current;
    if (!cell) return;
    const field = fields.get(cell.field) as ScalarField;
    // Over the record as it shows, the edits before it still saving included.
    const shown = records.get(cell.key);
    refocus.current = fromKeyboard;
    setEditing(null);
    if (then) table.moveCellSelection(then);
    // Left as it opened: never a save, even of a value the editor cannot hold (an enum's value
    // its options no longer have), which it would drop.
    if (!shown || cell.draft === cell.start) return;
    const next = recordWith(field, shown.record, cell.draft);
    if ("error" in next) return void toast.error(`${cell.field}: ${next.error}`);
    save(cell.key, cell.field, next.record);
  };

  useGridKeys(body, {
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
  const items = hydrated
    ? virtualizer.getVirtualItems()
    : rows.map((_, index) => ({ index, start: index * ROW_PX, end: (index + 1) * ROW_PX }));
  const before = items[0]?.start ?? 0;
  const after = hydrated ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;
  const visible = table.getVisibleLeafColumns();
  const conflictsByKey = Map.groupBy(conflicts.values(), (conflict) => conflict.key);

  if (listed.length === 0) {
    return (
      <Nothing title={filtered ? "No record matches" : "No records yet"}>
        {filtered ? "Change the filters to see others." : "Add one, or save one from a workflow."}
      </Nothing>
    );
  }

  const exportCsv = () => {
    const heads = visible.map((c) => HEADS[c.id] ?? c.id);
    const values = rows.map((row) => row.getVisibleCells().map((cell) => cell.getValue()));
    const url = URL.createObjectURL(new Blob([csv([heads, ...values])], { type: "text/csv" }));
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
                const head = {
                  style: { width: header.getSize() },
                  className: "sticky top-0 z-10 border-b bg-background",
                };
                const resizer = (
                  <div
                    aria-hidden
                    data-resizing={header.column.getIsResizing() || undefined}
                    className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-border data-resizing:bg-ring"
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    onDoubleClick={() => header.column.resetSize()}
                  />
                );
                return HEADS[header.id] ? (
                  <TableHead key={header.id} {...head}>
                    {HEADS[header.id]}
                    {resizer}
                  </TableHead>
                ) : (
                  <SortHead key={header.id} field={header.id} order={order} {...head}>
                    {resizer}
                  </SortHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody ref={setBody}>
            {before > 0 && (
              <tr aria-hidden>
                <td colSpan={visible.length} style={{ height: before }} />
              </tr>
            )}
            {items.map(({ index }) => {
              const row = rows[index]!;
              const saved = row.original;
              const rowConflicts = conflictsByKey.get(saved.key) ?? [];
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
                    const conflict = rowConflicts.find((other) => other.field === id);
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
                          <Value value={conflict ? conflict.mine : saved.record[id]} />
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
          {listed.length >= limit
            ? `The first ${limit} records: filter them, or show more, to see the rest`
            : listed.length === 1
              ? "1 record matches"
              : `${listed.length} records match`}
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
          {focused && (
            <>
              Row {focused.row.getDisplayIndex() + 1}, {HEADS[focused.column.id] ?? focused.column.id}
              {editable && (editing ? " · Enter to save · Esc to cancel" : " · Enter to change")}
              {!editing && " · Space expands"}
            </>
          )}
        </span>
        <Button variant="ghost" size="sm" onClick={exportCsv}>
          <DownloadSimpleIcon aria-hidden="true" data-icon="inline-start" />
          Export CSV
        </Button>
      </footer>
    </div>
  );
}
