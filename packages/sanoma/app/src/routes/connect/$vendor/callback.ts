import { createFileRoute } from "@tanstack/react-router";
import { connectionCallback } from "../../../server/connect.ts";

/** Where an OAuth provider sends the person back after consent: the attempt received (server/connect.ts). */
export const Route = createFileRoute("/connect/$vendor/callback")({
  server: {
    handlers: { GET: ({ request, context, params }) => connectionCallback(context.app, request, params.vendor) },
  },
});
