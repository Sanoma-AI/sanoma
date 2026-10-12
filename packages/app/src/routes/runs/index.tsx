import { createFileRoute, redirect } from "@tanstack/react-router";

// Runs are listed on their workflow's page now; this keeps old links and bookmarks working.
export const Route = createFileRoute("/runs/")({
  beforeLoad: () => {
    throw redirect({ to: "/workflows" });
  },
});
