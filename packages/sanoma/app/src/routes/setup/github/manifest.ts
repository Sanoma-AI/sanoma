import { createFileRoute } from "@tanstack/react-router";
import { manifestPage } from "../../../server/setup.ts";

/** Creates the company's GitHub App: a page that posts the App's manifest to GitHub (server/setup.ts). */
export const Route = createFileRoute("/setup/github/manifest")({
  server: { handlers: { GET: ({ request, context }) => manifestPage(context, request) } },
});
