import { createFileRoute, redirect } from "@tanstack/react-router";

// A new run starts from the New run panel of the workflow's page (`?new`) now; this keeps old
// links and bookmarks working, with their scenario (Sandbox) and rail filter: the search goes
// along as it is, and the target reads it.
export const Route = createFileRoute("/workflows/$name/new")({
  // Before any loader, the layout's too: a workflow that does not exist is the page's not-found.
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/workflows/$name", params, search: (prev) => ({ ...prev, new: true }) });
  },
});
