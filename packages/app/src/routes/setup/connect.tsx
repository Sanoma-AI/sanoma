import { createFileRoute, redirect } from "@tanstack/react-router";
import { ConnectSearch } from "../../queries.ts";

/** `/setup/connect`: redirects to its page under Hosting, with how creating the GitHub App went. */
export const Route = createFileRoute("/setup/connect")({
  validateSearch: ConnectSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/hosting/connect", search });
  },
});
