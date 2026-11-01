import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { postCall } from "../../server/core.ts";

/**
 * A site's `api` over plain JSON (`callApi`), for a client that is not the app's page: Sanoma
 * Cloud's connector starts sanoma-ops's workflows here with its bearer token. A request with a
 * bearer carries no cookie's authority, so only one without is checked for CSRF.
 */
export const Route = createFileRoute("/api/call")({
  server: {
    middleware: [
      createCsrfMiddleware({ filter: ({ request }) => !/^Bearer /i.test(request.headers.get("authorization") ?? "") }),
    ],
    handlers: { POST: ({ request, context }) => postCall(request, context) },
  },
});
