import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { errorMessage } from "@sanoma-ai/workflows/shared";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useMemo } from "react";
import { Card, CardAction, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { cn } from "#/lib/utils.ts";
import { useActor } from "../../actor.ts";
import { ButtonLink, CardHeading, CrumbHeader, Notice, pageTitle, UsedBy } from "../../components/common.tsx";
import { DataGrid, GridFilters } from "../../components/data-grid.tsx";
import { RecordForm } from "../../components/record-form.tsx";
import {
  closeRecord,
  collectionNamed,
  configQuery,
  DataSearch,
  listQueryOf,
  recordsQuery,
  usedBy,
} from "../../queries.ts";

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
  // reads nothing for a link's preload. A refusal is the page's to show, not the loader's.
  loader: async ({ context: { queryClient }, params, deps }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const collection = collectionNamed(params.name)(config);
    if (!collection) throw notFound();
    if (import.meta.env.SSR)
      await queryClient.prefetchQuery(recordsQuery(collection.name, listQueryOf(collection, deps)));
    return { crumb: collection.title ?? collection.name };
  },
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  component: CollectionPage,
  notFoundComponent: () => <Notice variant="destructive">No collection {Route.useParams().name}.</Notice>,
});

/**
 * A collection: where it is declared, its records in a grid with Add record, the record form
 * beside it while a record is open (`?record=`, or `?new`), and the workflows that use it.
 */
function CollectionPage() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const select = useMemo(
    () => (config: ConfigDescription) => ({ collection: collectionNamed(name)(config), ...usedBy(name)(config) }),
    [name],
  );
  const {
    data: { collection, workflows, sites },
  } = useSuspenseQuery({ ...configQuery(), select });
  // The loader found it; a config that no longer has it reads as not found.
  if (!collection) throw notFound();
  const query = listQueryOf(collection, search);
  // Every read is the policy's to decide as someone: none until the page knows who you are.
  const { actor } = useActor();
  const records = useQuery({
    ...recordsQuery(name, query),
    enabled: actor !== null,
    // The rows stay while a filter's are read.
    placeholderData: keepPreviousData,
  });
  const navigate = Route.useNavigate();
  const close = () => void navigate({ search: closeRecord, resetScroll: false });
  const formOpen = search.new === true || search.record !== undefined;
  const saved = search.record === undefined ? undefined : records.data?.find((r) => r.key === search.record);

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
        {collection.declared && (
          <span className="text-sm text-muted-foreground">
            Declared in{" "}
            <Link
              to="/resources"
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
        <GridFilters key={name} collection={collection} search={search} />
        {/* The form beside the grid on a wide screen, under it on a narrow one; the grid scrolls sideways in its column. */}
        <div className={cn("grid items-start gap-4", formOpen && "lg:grid-cols-[minmax(0,1fr)_24rem]")}>
          <div className="min-w-0">
            {records.data ? (
              <DataGrid
                collection={collection}
                records={records.data}
                order={query.order}
                open={search.record}
                filtered={query.where !== undefined}
                limit={query.limit}
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
                {search.new || saved ? (
                  <RecordForm
                    // A new record's people start as whoever is asking: drawn again once the
                    // browser has read who (none while the server renders).
                    key={search.new ? `new:${actor ?? ""}` : search.record}
                    collection={collection}
                    saved={saved}
                    actor={actor}
                    onDone={close}
                  />
                ) : records.data ? (
                  <Notice>
                    No record <code>{search.record}</code> among those listed: it may be filtered out, or gone.
                  </Notice>
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
