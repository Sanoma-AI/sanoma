import { createFileRoute, redirect } from "@tanstack/react-router";
import { HostingSearch } from "../queries.ts";

/** `/resources`, the page Hosting replaced: redirects there, with the declaration it shows. */
export const Route = createFileRoute("/resources")({
  validateSearch: HostingSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/hosting", search });
  },
});
