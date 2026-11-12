import { createFileRoute } from "@tanstack/react-router";
import { sanomaCallback } from "../../../server/sanoma-sign-in.ts";

/** Where Sanoma sends the browser back after signing in: the code redeemed and the Cloud token stored (server/sanoma-sign-in.ts). */
export const Route = createFileRoute("/hosting/sanoma/callback")({
  server: { handlers: { GET: ({ request, context }) => sanomaCallback(context.app, request) } },
});
