import { createFileRoute, redirect } from "@tanstack/react-router";

// Runs are listed on the Workflows page's All runs view now; this keeps old links and bookmarks working.
export const Route = createFileRoute("/runs/")({
  beforeLoad: () => {
    throw redirect({ to: "/workflows", search: { view: "runs" } });
  },
});
