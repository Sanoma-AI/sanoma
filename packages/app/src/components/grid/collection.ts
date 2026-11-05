import type { Saved } from "@sanoma-ai/workflows/shared";
import { createCollection, createPacedMutations, queueStrategy, type Transaction } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

// A Data page's records as a TanStack DB collection: the rows `list` read for the page's search,
// through `recordsQuery`'s key and function, so the loader's prefetch (on the server, and in the
// browser as it hydrates) is what the collection starts with. Every write is an optimistic
// change of the collection whose handler makes the one call that leaves the browser, as the
// person asking: an insert `data.<name>.save` with `ifAbsent`, an update `save` with `ifRecord`
// (the record as last read or saved), a delete `delete`. Once a call answers, the handler
// writes the record it saved into the collection; a refused call rolls the change back.
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
  };
  held: (err: unknown, queryClient: QueryClient) => boolean;
}

function createRecordsView(queryClient: QueryClient, { query, calls, held }: RecordsSource) {
  // The record `key` as the collection last read or saved it (the query's rows, which its writes
  // keep): what an update is saved over, never an edit before it still on screen, which its
  // call may have held or saved reshaped. Not the collection's `base`, which holds a save's
  // answer back while another record's save is under way.
  const stored = (key: string) =>
    queryClient.getQueryData<Saved[]>(query.queryKey)?.find((row) => row.key === key)?.record;
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
            : { record, ifRecord: stored(mutation.key) ?? (mutation.original as Saved).record },
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
  return { collection, edit };
}

/** A Data page's records (`collection`) and each record's queue of edits, the grid's and the form's (`edit`). */
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
