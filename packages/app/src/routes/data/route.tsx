import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/**
 * The collections' layout, with no component of its own: "Data" in the breadcrumb, before a
 * collection's title, and the Data section of the sidebar, its panel listing the collections.
 */
export const Route = createFileRoute("/data")({
  staticData: { crumb: "Data", section: "data" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
