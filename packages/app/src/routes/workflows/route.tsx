import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/** The workflows' layout, with no component of its own: "Workflows" in the breadcrumb, before a workflow's title. */
export const Route = createFileRoute("/workflows")({
  staticData: { crumb: "Workflows" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
