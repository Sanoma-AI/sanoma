import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/** The runs' layout, with no component of its own: "Runs" in the breadcrumb, before a run's name. */
export const Route = createFileRoute("/runs")({
  staticData: { crumb: "Runs" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
