import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { errorMessage, personsOf } from "@sanoma-ai/workflows/shared";
import { hashKey, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import { Card, CardAction, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { cn } from "#/lib/utils.ts";
import { useActor } from "../../actor.ts";
import type { UntypedApi } from "../../api-client.ts";
import {
  ButtonLink,
  CardHeading,
  CrumbHeader,
  Notice,
  pageTitle,
  toastIfHeld,
  UsedBy,
} from "../../components/common.tsx";
import { GridFilters } from "../../components/data-grid.tsx";
import { recordsView } from "../../components/grid/collection.ts";
import { DataGrid } from "../../components/grid/grid.tsx";
import { STAGED_FIRST } from "../../components/grid/staged.tsx";
import { RecordForm } from "../../components/record-form.tsx";
import { RecordHistory } from "../../components/record-history.tsx";
import {
  api,
  closeRecord,
  collectionNamed,
  configQuery,
  countQuery,
  DataSearch,
  historyQuery,
  listQueryOf,
  recordsQuery,
  usedBy,
} from "../../queries.ts";

/** No records view yet: nothing staged to be told of. */
const unstaged = () => () => {};

export const Route = createFileRoute("/data/$name")({
  validateSearch: DataSearch,
  // The grid's width is the window's: a collection may have many fields.
  staticData: { wide: true },
  // What `list` is asked: opening a record in the form reads no records again.
  loaderDeps: ({ search: { order, limit, key, where } }) => ({ order, limit, key, where }),
  // The page reads the config and the records from the query client; the loader returns only its
  // name, the collection's title. The records are read as the person asking: while the server
  // renders (the loopback login's cookie), here, so the page arrives with them; in the browser,
  // by the page, which keeps the rows on screen while a filter's are read, waits for a name, and
  // reads nothing for a link's preload. A refusal is the page's to show, not the loader's. The
  // open record's history the same way: on the server, from the search the request came with.
  loader: async ({ context: { queryClient }, params, deps, location }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const collection = collectionNamed(params.name)(config);
    if (!collection) throw notFound();
    if (import.meta.env.SSR) {
      const { record } = location.search as DataSearch;
      await Promise.all([
        queryClient.prefetchQuery(recordsQuery(collection.name, listQueryOf(collection, deps))),
        record !== undefined && queryClient.prefetchQuery(historyQuery(collection.name, record)),
      ]);
    }
    return { crumb: collection.title ?? collection.name };
  },
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: CollectionPage,
  notFoundComponent: () => <Notice variant="destructive">No collection {Route.useParams().name}.</Notice>,
});

/**
 * A collection: where it is declared, its records in a grid you edit in place, with Add record,
 * the record form beside it while a record is open (`?record=`, or `?new`; Space on a cell opens
 * its record), and the workflows that use it.
 */
function CollectionPage() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const select = useMemo(
    () => (config: ConfigDescription) => ({
      collection: collectionNamed(name)(config),
      people: personsOf(config.resources).map((person) => person.id),
      ...usedBy(name)(config),
    }),
    [name],
  );
  const {
    data: { collection, people, workflows, sites },
  } = useSuspenseQuery({ ...configQuery(), select });
  // The loader found it; a config that no longer has it reads as not found.
  if (!collection) throw notFound();
  const query = listQueryOf(collection, search);
  // Every read is the policy's to decide as someone: none until the page knows who you are.
  const { actor } = useActor();
  const records = useQuery({
    ...recordsQuery(name, query),
    enabled: actor !== null,
    // The rows stay while a filter's are read: this collection's, never another's, whose grid
    // would edit them under this one's fields.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === name ? previous : undefined),
  });
  // The search whose rows are on screen: this one once its records are read, the one before
  // while they are (`placeholderData`). Its collection is what the grid and the form change.
  const [lastRead, setLastRead] = useState(query);
  const shown = records.isPlaceholderData ? lastRead : query;
  if (hashKey([shown]) !== hashKey([lastRead])) setLastRead(shown);
  const queryClient = useQueryClient();
  const view = records.data
    ? recordsView(queryClient, {
        query: recordsQuery(name, shown),
        key: collection.key,
        calls: (api as UntypedApi).data[name],
        held: toastIfHeld,
        history: (key) => historyQuery(name, key).queryKey,
      })
    : undefined;
  // A change is staged over the view of one search: a search that reads other records, or
  // another page, would lose it. While one is, the controls that change the search are
  // disabled, anything else that would leave it (Back, a link) says why it does not, and
  // closing the tab asks first.
  const staged = useSyncExternalStore(
    view?.stage.subscribe ?? unstaged,
    () => view?.stage.current() !== undefined,
    () => false,
  );
  // Once per collection: a new function each render would register the blocker again each render.
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      // What a location's search reads, which a staged change is over.
      const reads = (location: { search: unknown }) =>
        hashKey([listQueryOf(collection, location.search as DataSearch)]);
      const leaves = next.pathname !== current.pathname || reads(next) !== reads(current);
      if (leaves) toast.info(STAGED_FIRST);
      return leaves;
    },
    [collection],
  );
  useBlocker({ disabled: !staged, shouldBlockFn });
  const navigate = Route.useNavigate();
  const close = () => void navigate({ search: closeRecord, resetScroll: false });
  const formOpen = search.new === true || search.record !== undefined;
  // The record as the collection has it, an edit of it still saving included: the form must not
  // build its values from the rows as stored and save over that edit.
  const saved = search.record === undefined ? undefined : view?.collection.get(search.record);

  return (
    <>
      <CrumbHeader
        action={
          <ButtonLink>
            <Link to="." search={(prev) => ({ ...closeRecord(prev), new: true })} resetScroll={false}>
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              Add record
            </Link>
          </ButtonLink>
        }
      >
        <code className="text-muted-foreground">data.{name}</code>
        {collection.app && <Badge variant="secondary">{collection.app}</Badge>}
        {collection.declared && (
          <span className="text-sm text-muted-foreground">
            Declared in{" "}
            <Link
              to="/hosting"
              search={{ resource: collection.declared.id }}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {collection.declared.id}
            </Link>
          </span>
        )}
      </CrumbHeader>
      <section aria-label="Records" className="flex flex-col gap-(--gap-section)">
        {/* Its own per collection: a filter typed on one never lands on another. */}
        <GridFilters key={name} collection={collection} search={search} staged={staged} />
        {/* The form beside the grid on a wide screen, under it on a narrow one; the grid scrolls sideways in its column. */}
        <div className={cn("grid items-start gap-4", formOpen && "lg:grid-cols-[minmax(0,1fr)_24rem]")}>
          <div className="min-w-0">
            {view ? (
              <DataGrid
                // One grid per collection: its widths, edit and conflicts are that collection's.
                key={name}
                collection={collection}
                view={view}
                order={shown.order}
                open={search.record}
                where={shown.where}
                limit={shown.limit}
                reading={records.isPlaceholderData}
                hide={search.hide}
                people={people}
              />
            ) : actor === null ? (
              <Notice>Say who you are to see the records: the policy decides each read for the person asking.</Notice>
            ) : records.isError ? (
              <Notice variant="destructive">{errorMessage(records.error)}</Notice>
            ) : (
              <Skeleton role="status" aria-label="Loading the records" className="h-40 w-full" />
            )}
          </div>
          {formOpen && (
            <Card aria-label="Record" role="region" className="lg:sticky lg:top-4">
              <CardHeader>
                <CardHeading className="self-center">{search.new ? "New record" : `Edit ${search.record}`}</CardHeading>
                <CardAction>
                  <ButtonLink variant="ghost" size="icon-sm">
                    <Link to="." search={closeRecord} resetScroll={false}>
                      <XIcon aria-hidden="true" />
                      <span className="sr-only">Close</span>
                    </Link>
                  </ButtonLink>
                </CardAction>
              </CardHeader>
              <CardContent>
                {view && (search.new || saved) ? (
                  <div className="flex flex-col gap-6">
                    <RecordForm
                      // A new record's people start as whoever is asking: drawn again once the
                      // browser has read who (none while the server renders).
                      key={search.new ? `new:${actor ?? ""}` : search.record}
                      collection={collection}
                      view={view}
                      saved={saved}
                      staged={staged}
                      actor={actor}
                      onDone={() => {
                        close();
                        // An add or a delete changes how many match.
                        void queryClient.invalidateQueries({ queryKey: countQuery(name, shown.where).queryKey });
                      }}
                    />
                    {saved && <RecordHistory name={name} recordKey={saved.key} />}
                  </div>
                ) : records.data ? (
                  <Notice>
                    No record <code>{search.record}</code> among those listed: it may be filtered out, or gone.
                  </Notice>
                ) : actor === null ? (
                  <Notice>Say who you are to add or change a record.</Notice>
                ) : (
                  <Skeleton className="h-40 w-full" />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </section>
      <UsedBy workflows={workflows} sites={sites} />
    </>
  );
}
