import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { bearerOf } from "../../login/public.ts";
import { postCall } from "../../server/core.ts";

/**
 * A site's `api` over plain JSON (`callApi`), for a client that is not the app's page: Sanoma
 * Cloud's connector starts sanoma-ops's workflows here with its bearer token. A request with an
 * api token (`bearerOf`, as the public login reads it) acts as the token, not as a cookie, so only
 * one without is checked for CSRF.
 */
export const Route = createFileRoute("/api/call")({
  server: {
    middleware: [createCsrfMiddleware({ filter: ({ request }) => bearerOf(request) === undefined })],
    handlers: { POST: ({ request, context }) => postCall(request, context) },
  },
});
