import { createFileRoute, redirect } from "@tanstack/react-router";
import { Notice } from "#/components/common.tsx";
import { runLink, runQuery } from "#/queries.ts";

// A run's page is under its workflow's now; this keeps old links and bookmarks working.
export const Route = createFileRoute("/runs/$id")({
  beforeLoad: async ({ context: { queryClient }, params }) => {
    // Read once, here, for the page it leads to as well.
    const { run } = await queryClient.query({ ...runQuery(params.id), staleTime: "static" });
    throw redirect(runLink(run));
  },
  // getRun throws the router's not-found for a run that does not exist.
  notFoundComponent: () => <Notice variant="destructive">No run {Route.useParams().id}.</Notice>,
});
