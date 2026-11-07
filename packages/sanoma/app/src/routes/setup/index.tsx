import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/setup`, the Go live page: going live is Hosting's state while nothing is declared to run on. */
export const Route = createFileRoute("/setup/")({
  beforeLoad: () => {
    throw redirect({ to: "/hosting" });
  },
});
