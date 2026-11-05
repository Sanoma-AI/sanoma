import type { Saved } from "@sanoma-ai/workflows/shared";
import { createCollection, createPacedMutations, queueStrategy, type Transaction } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

// A Data page's records as a TanStack DB collection: the rows `list` read for the page's search,
// through `recordsQuery`'s key and function, so the loader's prefetch (on the server, and in the
// browser as it hydrates) is what the collection starts with. Every write is an optimistic
// change of the collection whose handler makes the one call that leaves the browser, as the
// person asking: an insert `data.<name>.save` with `ifAbsent`, an update `save` with `ifRecord`
// (the record as the change found it), a delete `delete`. Once a call answers, the handler
// writes the record it saved into the collection; a refused call rolls the change back.
// It imports nothing that defines a server function (`queries.ts`, `common.tsx`): the page hands
// it those, so a test can hand it fakes.

/** Where a transaction's handler leaves, by key, the records as its calls left them, in its metadata. */
const SAVED = "saved";

/**
 * The record `key` as a transaction's call left it, null once deleted: undefined while no call
 * answered, or when the call is held for an approval.
 */
export const savedIn = (tx: Pick<Transaction, "metadata">, key: string): Saved | null | undefined =>
  (tx.metadata[SAVED] as Record<string, Saved | null> | undefined)?.[key];

/** A grid edit: the record `key` names, as the edit leaves it. */
export interface RecordEdit {
  key: string;
  record: Record<string, unknown>;
}

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
    }) => Promise<unknown>;
    delete: (input: { key: string }) => Promise<unknown>;
  };
  held: (err: unknown, queryClient: QueryClient) => boolean;
}

function createRecordsView(queryClient: QueryClient, { query, calls, held }: RecordsSource) {
  const persist = async ({ transaction }: { transaction: Transaction<Saved> }) => {
    const saved: Record<string, Saved | null> = {};
    for (const mutation of transaction.mutations) {
      try {
        if (mutation.type === "delete") {
          await calls.delete({ key: mutation.key });
          await collection.utils.writeDelete(mutation.key);
          saved[mutation.key] = null;
          continue;
        }
        const { record } = mutation.modified;
        const answer = (await calls.save(
          mutation.type === "insert"
            ? { record, ifAbsent: true }
            : { record, ifRecord: (mutation.original as Saved).record },
        )) as Saved;
        await collection.utils.writeUpsert(answer);
        saved[answer.key] = answer;
      } catch (err) {
        // A call held for an approval is not refused: it waits, as a run of `call`. Nothing is
        // written, so the row shows the record as it is stored, not the change, until that run
        // ends (the grid marks it from the runs waiting, and reads it again then).
        if (!held(err, queryClient)) throw err;
      }
    }
    transaction.metadata[SAVED] = saved;
  };
  const collection = createCollection({
    ...queryCollectionOptions({
      // `recordsQuery`'s: its options' types are Query's whole range.
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
    // A server's render is one request's: what it made is let go soon after (longer than a page
    // takes to render, never the browser's 5 minutes).
    ...(!("document" in globalThis) && { gcTime: 10_000 }),
  });
  // The grid's edits, one after another, so each is saved over the record the one before it
  // saved (`ifRecord`), never raced to the server: a change refused rolls back those made on it.
  const edit = createPacedMutations<RecordEdit, Saved>({
    onMutate: ({ key, record }) => {
      collection.update(key, (draft) => {
        draft.record = record;
      });
    },
    mutationFn: persist,
    strategy: queueStrategy({ wait: 0 }),
  });
  return { collection, edit };
}

/** A Data page's records (`collection`) and the grid's queue of edits to them (`edit`). */
export type RecordsView = ReturnType<typeof createRecordsView>;

/** By query client, the views made, by their query's key: the one view per search the library expects. */
const views = new WeakMap<QueryClient, Map<string, RecordsView>>();

/** The records `source` reads, in `queryClient`: made once for its query's key, then the same. */
export function recordsView(queryClient: QueryClient, source: RecordsSource): RecordsView {
  let byKey = views.get(queryClient);
  if (!byKey) views.set(queryClient, (byKey = new Map()));
  const id = hashKey(source.query.queryKey);
  let view = byKey.get(id);
  if (!view) byKey.set(id, (view = createRecordsView(queryClient, source)));
  return view;
}
