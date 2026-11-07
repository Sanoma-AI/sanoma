import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/** The connectors' layout, with no component of its own: "Connectors" in the breadcrumb, before a connector's title. */
export const Route = createFileRoute("/connectors")({
  staticData: { crumb: "Connectors" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
