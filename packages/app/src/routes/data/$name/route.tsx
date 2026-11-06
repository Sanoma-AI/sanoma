import { createFileRoute, notFound } from "@tanstack/react-router";
import { Notice, pageTitle } from "../../../components/common.tsx";
import { collectionNamed, configQuery } from "../../../queries.ts";

/**
 * Layout for a collection's grid (`index.tsx`) and its import (`import.tsx`), with no component:
 * finds the collection, else not-found, and names its crumb, the collection's title.
 */
export const Route = createFileRoute("/data/$name")({
  loader: async ({ context: { queryClient }, params }) => {
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const collection = collectionNamed(params.name)(config);
    if (!collection) throw notFound();
    return { crumb: collection.title ?? collection.name };
  },
  head: ({ loaderData, params }) => pageTitle(loaderData?.crumb ?? params.name),
  notFoundComponent: () => <Notice variant="destructive">No collection {Route.useParams().name}.</Notice>,
});
