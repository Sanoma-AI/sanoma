import type { Saved } from "@sanoma-ai/workflows/shared";
import {
  createCollection,
  createPacedMutations,
  createTransaction,
  queueStrategy,
  type Transaction,
} from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { errorBodyOf } from "../../api.ts";

// A Data page's records as a TanStack DB collection: the rows `list` read for the page's search,
// through `recordsQuery`'s key and function, so the loader's prefetch (on the server, and in the
// browser as it hydrates) is what the collection starts with. Every write is an optimistic
// change of the collection whose handler makes the one call that leaves the browser, as the
// person asking: an insert `data.<name>.save` with `ifAbsent`, an update `save` with `ifRecord`
// (the record as last read or saved), a delete `delete`. Once a call answers, the handler
// writes the record it saved into the collection; a refused call rolls the change back.
//
// A paste, a fill, an edit of a selection, Delete and a new record are staged instead: steps of
// one explicit transaction (`stage`), shown at once and saved by none until Save, which makes
// one `data.<name>.saveMany` of every record it changes (`save`). Ours, on purpose, around the
// library's whole-transaction rollback: the steps, so Cmd/Ctrl+Z takes back the last (`undo`,
// the transaction made again from the steps before it); a held batch, which counts as saved
// (its rows marked from the runs waiting); and a refusal that keeps the change (a conflict, the
// records a denial leaves), made again from its steps.
// It imports nothing that defines a server function (`queries.ts`, `common.tsx`): the page hands
// it those, so a test can hand it fakes.

/**
 * The record `key` as a transaction's call left it (`persist` keeps it in the transaction's
 * metadata, by key), null once deleted: undefined while no call answered, or when the call is
 * held for an approval.
 */
export const savedIn = (tx: Pick<Transaction, "metadata">, key: string) => tx.metadata[key] as Saved | null | undefined;

/** A grid edit: the record `key` names, as the edit leaves it. */
export interface RecordEdit {
  key: string;
  record: Record<string, unknown>;
}

/**
 * `record` with `field` set to `value`, or left out when `value` is undefined: in the record's
 * own order, so an edit that changes nothing reads as the record it was.
 */
export function withValue(record: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const next = { ...record };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

/** What `saveMany` answers for each entry, in the order sent: a record saved, or a key deleted. */
export type ManyAnswer = Saved | { key: string; deleted: boolean };

/** The most entries one `saveMany` takes. */
export const SAVE_MANY_MAX = 1000;

/**
 * A staged new record's key, until its own is saved: one no record has (a private-use character
 * first), and one `CSS.escape` keeps as it is, so the grid finds its cells by it.
 */
const NEW = "\uE000new:";
let made = 0;
/** A key for a new record, staged: in the order they are made, as text sorts. */
export const newKey = () => `${NEW}${String(++made).padStart(8, "0")}`;
/** Whether `key` is a staged new record's. */
export const isNew = (key: string) => key.startsWith(NEW);

/** A cell a step changes: to `value`, or, when its text is no value of the field, to the text with why (`error`). */
export interface CellChange {
  key: string;
  field: string;
  value: unknown;
  error?: string;
}

/** One gesture staged, which Cmd/Ctrl+Z takes back whole: a paste, a fill, an edit, Delete, a new record. */
export interface Step {
  /** What it was, for the bar: "paste", "fill", "edit", "delete", "new record". */
  what: string;
  /** What it did, for the footer: "Pasted 3 rows × 2 columns at row 4, stage". */
  said: string;
  /** The new records it adds, by their keys of `newKey`'s, before its cells. */
  adds?: string[];
  cells?: CellChange[];
  /** The records it deletes, shown struck until saved. */
  deletes?: string[];
}

/** The change staged: its transaction, whose mutations are the records it changes, and the steps that made it. */
export interface Staged {
  tx: Transaction<Saved>;
  steps: readonly Step[];
}

/** A record whose change cannot be saved over it: changed since, or gone (`current` null). */
export interface Conflicted {
  key: string;
  current: Saved | null;
}

/**
 * What a Save came to: how many records it saved; held for an approval in a run of `call` (none
 * saved until it is approved); refused by the policy, the keys it denied dropped from the change
 * and the rest still staged; or conflicts to settle first, nothing saved and all still staged.
 */
export type SaveOutcome =
  | { saved: number }
  | { held: number; runId: string | undefined }
  | { denied: string[]; error: unknown }
  | { conflicts: Conflicted[] };

/** The keys `steps` change. */
const keysOf = (steps: readonly Step[]) =>
  new Set(steps.flatMap((step) => [...(step.cells ?? []).map((cell) => cell.key), ...(step.deletes ?? [])]));

/** `steps` without what they do to the records `drop` says, and without a step left doing nothing. */
const without = (steps: readonly Step[], drop: (key: string, field?: string) => boolean): Step[] =>
  steps.flatMap((step) => {
    const kept = {
      ...step,
      adds: step.adds?.filter((key) => !drop(key)),
      cells: step.cells?.filter((cell) => !drop(cell.key, cell.field)),
      deletes: step.deletes?.filter((key) => !drop(key)),
    };
    return kept.adds?.length || kept.cells?.length || kept.deletes?.length ? [kept] : [];
  });

/**
 * What a page's records are made from: `query`, `recordsQuery(name, search)` (what the loader
 * prefetched); `calls`, the collection's operations as `api.data.<name>` makes them; and `held`,
 * which says a call is held for an approval (`toastIfHeld`) and answers whether it was.
 */
export interface RecordsSource {
  query: { queryKey: QueryKey; queryFn?: unknown; staleTime?: unknown };
  calls: {
    save: (input: {
      record: Record<string, unknown>;
      ifAbsent?: true;
      ifRecord?: Record<string, unknown>;
    }) => Promise<Saved>;
    delete: (input: { key: string }) => Promise<unknown>;
    saveMany: (input: {
      records: { record: Record<string, unknown>; ifRecord?: Record<string, unknown> }[];
      deletes?: { key: string; ifRecord?: Record<string, unknown> }[];
    }) => Promise<ManyAnswer[]>;
  };
  held: (err: unknown, queryClient: QueryClient) => boolean;
}

function createRecordsView(queryClient: QueryClient, { query, calls, held }: RecordsSource) {
  // The records as the collection last read or saved them (the query's rows, which its writes
  // keep), by key: what an update is saved over, never an edit before it still on screen, which
  // its call may have held or saved reshaped. Not the collection's `base`, which holds a save's
  // answer back while another record's save is under way.
  const storedRows = () =>
    new Map((queryClient.getQueryData<Saved[]>(query.queryKey) ?? []).map((row) => [row.key, row] as const));
  const persist = async ({ transaction }: { transaction: Transaction<Saved> }) => {
    for (const mutation of transaction.mutations) {
      try {
        if (mutation.type === "delete") {
          await calls.delete({ key: mutation.key });
          await collection.utils.writeDelete(mutation.key);
          transaction.metadata[mutation.key] = null;
          continue;
        }
        const { record } = mutation.modified;
        const answer = await calls.save(
          mutation.type === "insert"
            ? { record, ifAbsent: true }
            : {
                record,
                ifRecord: storedRows().get(mutation.key)?.record ?? (mutation.original as Saved).record,
              },
        );
        await collection.utils.writeUpsert(answer);
        transaction.metadata[answer.key] = answer;
      } catch (err) {
        // A call held for an approval is not refused: it waits, as a run of `call`. Nothing is
        // written, so the row shows the record as it is stored, not the change, until that run
        // ends (the grid marks it from the runs waiting, and reads it again then).
        if (!held(err, queryClient)) throw err;
      }
    }
  };
  const collection = createCollection({
    ...queryCollectionOptions({
      // `recordsQuery`'s: its options' types are Query's whole range, which this one's do not take.
      queryKey: query.queryKey,
      queryFn: query.queryFn as () => Promise<Saved[]>,
      staleTime: query.staleTime as number,
      queryClient,
      getKey: (row: Saved) => row.key,
      // At once, from the query client: what the loader read is the first render's rows.
      startSync: true,
      onInsert: persist,
      onUpdate: persist,
      onDelete: persist,
    }),
    // Let go, its query with it, 10 s after nothing shows it: another search's, never read again
    // as the window takes the focus, or a server's render once sent (none subscribes there).
    gcTime: 10_000,
  });
  // The edits of each record one after another, so each is saved over the record the one before
  // it saved (`ifRecord`), never raced to the server; another record's do not wait for them. A
  // change refused rolls back those made on it.
  const queues = new Map<string, (edit: RecordEdit) => Transaction<Saved>>();
  const edit = (change: RecordEdit) => {
    let queue = queues.get(change.key);
    if (!queue) {
      queue = createPacedMutations<RecordEdit, Saved>({
        onMutate: ({ key, record }) => {
          collection.update(key, (draft) => {
            draft.record = record;
          });
        },
        mutationFn: persist,
        strategy: queueStrategy({ wait: 0 }),
      });
      queues.set(change.key, queue);
    }
    return queue(change);
  };

  // The change staged, none while nothing is; who is told when it changes (`subscribe`).
  let staged: Staged | undefined;
  const listeners = new Set<() => void>();
  const show = (next: Staged | undefined) => {
    staged = next;
    for (const listener of listeners) listener();
  };
  // Each record the change is staged over, as stored when a step first changed it: its
  // `ifRecord`, and what a Save's fresh read is compared with.
  const base = new Map<string, Saved>();
  // The records a Save sends: all the change's, or those `save` was told.
  let sending: ReadonlySet<string> | undefined;

  /** `step`'s changes, in `tx`: a new record, its cells and the others', a delete (not shown until saved, so the row stays to be struck). */
  const apply = (tx: Transaction<Saved>, step: Step) => {
    const deleted = new Set(tx.mutations.flatMap((m) => (m.type === "delete" ? [m.key] : [])));
    for (const key of step.adds ?? []) collection.insert({ key, record: {}, updatedAt: "", updatedBy: "" });
    for (const { key, field, value } of step.cells ?? []) {
      // A record gone since, or deleted by a step before: nothing to change.
      if (!collection.has(key) || deleted.has(key)) continue;
      collection.update(key, (draft) => {
        draft.record = withValue(draft.record, field, value);
      });
    }
    for (const key of step.deletes ?? []) if (collection.has(key)) collection.delete(key, { optimistic: false });
  };

  /** The one `saveMany` of the records the change sends: each update over the record it was staged over. */
  const send = async ({ transaction }: { transaction: Transaction<Saved> }) => {
    const entries = transaction.mutations.filter((m) => !sending || sending.has(m.key));
    const over = (m: (typeof entries)[number]) => (base.get(m.key) ?? (m.original as Saved)).record;
    const records = entries.flatMap((m) =>
      m.type === "insert"
        ? [{ record: m.modified.record }]
        : m.type === "update"
          ? [{ record: m.modified.record, ifRecord: over(m) }]
          : [],
    );
    const deletes = entries.flatMap((m) => (m.type === "delete" ? [{ key: m.key, ifRecord: over(m) }] : []));
    try {
      const answers = await calls.saveMany({ records, ...(deletes.length > 0 && { deletes }) });
      // What the server saved, in the collection before the change's own rows let go of it.
      await collection.utils.writeUpsert(answers.filter((answer): answer is Saved => "record" in answer));
      await collection.utils.writeDelete(answers.flatMap((answer) => ("record" in answer ? [] : [answer.key])));
    } catch (err) {
      // Held for an approval: the batch waits as one run of `call`, and counts as sent.
      if (!held(err, queryClient)) throw err;
      transaction.metadata.held = errorBodyOf(err)?.runId ?? null;
    }
  };

  /** Stages `steps` as the change, its transaction made again from them; none closes it. */
  const reopen = (steps: readonly Step[]) => {
    if (staged?.tx.state === "pending") staged.tx.rollback();
    const keys = keysOf(steps);
    for (const key of base.keys()) if (!keys.has(key)) base.delete(key);
    if (steps.length === 0) return show(undefined);
    const tx = createTransaction<Saved>({ autoCommit: false, mutationFn: send });
    tx.mutate(() => {
      for (const step of steps) apply(tx, step);
    });
    show({ tx, steps });
  };

  const stage = {
    /** The change staged now, none while nothing is. */
    current: () => staged,
    /** Tells `listener` whenever the change does, until the function it answers is called. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Stages `step`, opening a change when none is: shown at once, saved by nothing until `save`. */
    add(step: Step) {
      const tx = staged?.tx ?? createTransaction<Saved>({ autoCommit: false, mutationFn: send });
      const rows = storedRows();
      for (const key of keysOf([step])) {
        const row = rows.get(key);
        if (row && !base.has(key)) base.set(key, row);
      }
      tx.mutate(() => apply(tx, step));
      show({ tx, steps: [...(staged?.steps ?? []), step] });
    },
    /** Takes back the last step. */
    undo: () => staged && reopen(staged.steps.slice(0, -1)),
    /** Takes back every step: nothing changed. */
    discard: () => reopen([]),
    /** Keep theirs: drops the change to `key`'s `field`, or to the whole record. */
    drop: (key: string, field?: string) =>
      staged && reopen(without(staged.steps, (k, f) => k === key && (field === undefined || f === field))),
    /** The record `key` as it stands, `current`, is what its change is saved over now; gone, the change is dropped. */
    rebase(key: string, current: Saved | null) {
      if (!current) stage.drop(key);
      else if (staged && keysOf(staged.steps).has(key)) base.set(key, current);
    },
    /**
     * Saves the change, or the records `only` names (the rest stay staged), as one `saveMany`.
     * First the records are read again: one changed since it was staged over is a conflict, and
     * nothing is sent. A refusal for a conflict keeps every step; one for the policy drops the
     * records it denied; anything else rolls the change back, nothing changed, and throws.
     */
    async save(only?: ReadonlySet<string>): Promise<SaveOutcome> {
      const open = staged;
      if (!open) return { saved: 0 };
      const sent = (key: string) => !only || only.has(key);
      await collection.utils.refetch();
      const rows = storedRows();
      const conflicts = open.tx.mutations.flatMap((m) => {
        const was = base.get(m.key);
        const now = rows.get(m.key);
        return was && sent(m.key) && now?.updatedAt !== was.updatedAt ? [{ key: m.key, current: now ?? null }] : [];
      });
      if (conflicts.length) return { conflicts };
      const count = open.tx.mutations.filter((m) => sent(m.key)).length;
      if (count > SAVE_MANY_MAX) throw new Error(`One change saves at most ${SAVE_MANY_MAX} records: save some first`);
      sending = only;
      try {
        await open.tx.commit();
      } catch (err) {
        const body = errorBodyOf(err);
        if (body?.code === "record_changed" && body.conflicts) {
          const gone = body.conflicts.flatMap(({ key, current }) => (current || !collection.has(key) ? [] : [key]));
          await collection.utils.writeUpsert(body.conflicts.flatMap(({ current }) => (current ? [current] : [])));
          await collection.utils.writeDelete(gone);
          reopen(open.steps);
          return { conflicts: body.conflicts };
        }
        if (body?.code === "policy_denied") {
          const denied = new Set(body.keys);
          reopen(without(open.steps, (key) => denied.has(key)));
          return { denied: [...denied], error: err };
        }
        reopen([]);
        throw err;
      } finally {
        sending = undefined;
      }
      reopen(without(open.steps, sent));
      return "held" in open.tx.metadata
        ? { held: count, runId: (open.tx.metadata.held as string | null) ?? undefined }
        : { saved: count };
    },
  };
  return { collection, edit, stage };
}

/**
 * A Data page's records (`collection`), each record's queue of edits, the grid's and the form's
 * (`edit`), and the change staged over them (`stage`).
 */
export type RecordsView = ReturnType<typeof createRecordsView>;

/**
 * By query client, the views made, by their query's key: the one view per search the library
 * expects, each until its collection is let go.
 */
const views = new WeakMap<QueryClient, Map<string, RecordsView>>();

/** The records `source` reads, in `queryClient`: made once for its query's key, then the same. */
export function recordsView(queryClient: QueryClient, source: RecordsSource): RecordsView {
  let byKey = views.get(queryClient);
  if (!byKey) views.set(queryClient, (byKey = new Map()));
  const id = hashKey(source.query.queryKey);
  const cached = byKey.get(id);
  if (cached) return cached;
  const view = createRecordsView(queryClient, source);
  byKey.set(id, view);
  view.collection.on("status:cleaned-up", () => {
    if (byKey.get(id) === view) byKey.delete(id);
  });
  return view;
}
