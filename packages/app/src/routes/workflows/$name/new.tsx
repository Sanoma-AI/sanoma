import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

// A new run starts from the workflow's own page now; this keeps old links and bookmarks working,
// with their scenario (Sandbox) and rail filter.
export const Route = createFileRoute("/workflows/$name/new")({
  validateSearch: z.object({ scenario: z.string().optional().catch(undefined) }),
  // Before any loader, the layout's too: a workflow that does not exist is the page's not-found.
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/workflows/$name", params, search: { scenario: search.scenario, runs: search.runs } });
  },
});
