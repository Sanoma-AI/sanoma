import { errorMessage } from "@sanoma-ai/workflows/shared";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { Card, CardAction, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { useActor } from "../../actor.ts";
import { ButtonLink, CardHeading, Notice, PageHeader, pageTitle, UsedBy } from "../../components/common.tsx";
import { DataGrid, GridFilters } from "../../components/data-grid.tsx";
import { RecordForm } from "../../components/record-form.tsx";
import { collectionNamed, configQuery, DataSearch, listQueryOf, recordsQuery, usedBy } from "../../queries.ts";

export const Route = createFileRoute("/data/$name")({
  validateSearch: DataSearch,
  // The grid's width is the window's: a collection may have many fields.
  staticData: { wide: true },
  // What `list` is asked: the record open in the form reads no records again.
  loaderDeps: ({ search: { order, limit, key, where } }) => ({ order, limit, key, where }),
  // The page reads the config and the records from the query client; the loader returns only its
  // name, the collection's title. The records are read as the person asking (while the server
  // renders, the loopback login's cookie); a refusal is the page's to show, not the loader's.
  loader: async ({ context: { queryClient }, params, deps }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const collection = collectionNamed(params.name)(config);
    if (!collection) throw notFound();
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
  const deps = Route.useLoaderDeps();
  const navigate = Route.useNavigate();
  const { data: collection } = useSuspenseQuery({ ...configQuery(), select: (c) => collectionNamed(name)(c)! });
  const selectUsedBy = useMemo(() => usedBy(name), [name]);
  const { data: used } = useSuspenseQuery({ ...configQuery(), select: selectUsedBy });
  const query = useMemo(() => listQueryOf(collection, deps), [collection, deps]);
  // Every read is the policy's to decide as someone: none until the page knows who you are.
  const { actor } = useActor();
  const records = useQuery({
    ...recordsQuery(name, query),
    enabled: actor !== null,
    // The rows stay while a filter's are read.
    placeholderData: keepPreviousData,
  });
  const close = () =>
    void navigate({ search: (prev) => ({ ...prev, record: undefined, new: undefined }), resetScroll: false });
  const open = search.new ? "new" : search.record;
  const saved = search.record === undefined ? undefined : records.data?.find((r) => r.key === search.record);

  return (
    <>
      <PageHeader
        action={
          <ButtonLink>
            <Link to="." search={(prev) => ({ ...prev, new: true, record: undefined })} resetScroll={false}>
              <PlusIcon data-icon="inline-start" />
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
      </PageHeader>
      <section aria-label="Records" className="flex flex-col gap-(--gap-section)">
        <GridFilters collection={collection} search={search} />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            {records.data ? (
              <DataGrid collection={collection} records={records.data} search={search} limit={query.limit ?? 0} />
            ) : records.isError ? (
              <Notice variant="destructive">{errorMessage(records.error)}</Notice>
            ) : (
              <Skeleton role="status" aria-label="Loading the records" className="h-40 w-full" />
            )}
          </div>
          {open && (
            <Card aria-label="Record" role="region" className="lg:sticky lg:top-4 lg:w-96 lg:shrink-0">
              <CardHeader>
                <CardHeading className="self-center">{open === "new" ? "New record" : `Edit ${open}`}</CardHeading>
                <CardAction>
                  <ButtonLink variant="ghost" size="icon-sm">
                    <Link
                      to="."
                      search={(prev) => ({ ...prev, record: undefined, new: undefined })}
                      resetScroll={false}
                    >
                      <XIcon />
                      <span className="sr-only">Close</span>
                    </Link>
                  </ButtonLink>
                </CardAction>
              </CardHeader>
              <CardContent>
                {open === "new" || saved ? (
                  <RecordForm key={open} collection={collection} saved={saved} onDone={close} />
                ) : records.data ? (
                  <Notice>
                    No record <code>{open}</code> among those listed: it may be filtered out, or gone.
                  </Notice>
                ) : (
                  <Skeleton className="h-40 w-full" />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </section>
      <UsedBy workflows={used.workflows} />
    </>
  );
}
