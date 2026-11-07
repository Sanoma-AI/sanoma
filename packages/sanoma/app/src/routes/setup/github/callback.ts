import { createFileRoute } from "@tanstack/react-router";
import { githubCallback } from "../../../server/setup.ts";

/** Where GitHub sends the person back with the new App's code: its keys are stored (server/setup.ts). */
export const Route = createFileRoute("/setup/github/callback")({
  server: { handlers: { GET: ({ request, context }) => githubCallback(context.app, request) } },
});
