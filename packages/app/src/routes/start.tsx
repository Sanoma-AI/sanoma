import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

// A workflow's runs start from its New run pane now; this keeps old links and bookmarks working.
export const Route = createFileRoute("/start")({
  validateSearch: z.object({ workflow: z.string().optional().catch(undefined) }),
  // Any name goes to its pane: the workflow's page decides whether it exists, or is retired.
  beforeLoad: ({ search }) => {
    if (search.workflow !== undefined) {
      throw redirect({ to: "/workflows/$name/new", params: { name: search.workflow } });
    }
    throw redirect({ to: "/workflows" });
  },
});
