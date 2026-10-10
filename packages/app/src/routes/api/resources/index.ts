import { createFileRoute } from "@tanstack/react-router";
import { json, resourcesView } from "../../../server/core.ts";

/**
 * The resources the data files declare and what is wrong in them, as the app read them when it
 * started, with the latest drift run and the latest finished one's report.
 */
export const Route = createFileRoute("/api/resources/")({
  server: {
    handlers: {
      GET: async ({ context }) => json(await resourcesView(context.app)),
    },
  },
});
