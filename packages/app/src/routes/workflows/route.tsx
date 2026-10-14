import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/**
 * The workflows' layout, with no component of its own: "Workflows" in the breadcrumb, before a
 * workflow's title, and the Workflows section of the sidebar, its panel beside the bar.
 */
export const Route = createFileRoute("/workflows")({
  staticData: { crumb: "Workflows", section: "workflows" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
