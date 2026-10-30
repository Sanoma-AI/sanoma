import { createFileRoute } from "@tanstack/react-router";
import { pageTitle } from "../../components/common.tsx";

/**
 * Hosting's layout, with no component of its own: "Hosting", the page's title and the crumb above
 * going live's Connect pages.
 */
export const Route = createFileRoute("/hosting")({
  staticData: { crumb: "Hosting" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
});
