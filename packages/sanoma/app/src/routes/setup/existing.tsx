import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/setup/existing`: redirects to its page under Hosting. */
export const Route = createFileRoute("/setup/existing")({
  beforeLoad: () => {
    throw redirect({ to: "/hosting/existing" });
  },
});
