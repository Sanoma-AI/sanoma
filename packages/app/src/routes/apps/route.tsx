import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/** The apps' layout, with no component of its own: "Apps", the list's title and the crumb above an app's. */
export const Route = createFileRoute("/apps")({
  staticData: { crumb: "Apps" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
