import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/**
 * The collections' layout, with no component of its own: "Data", the list's title and the crumb
 * above a collection's.
 */
export const Route = createFileRoute("/data")({
  staticData: { crumb: "Data" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
