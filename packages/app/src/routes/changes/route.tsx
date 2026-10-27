import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/** The changes' layout, with no component of its own: "Changes", the list's title and the crumb above a change's. */
export const Route = createFileRoute("/changes")({
  staticData: { crumb: "Changes" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
