import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { bearerOf } from "../../login/public.ts";
import { postCall } from "../../server/core.ts";

/**
 * A site's `api` over plain JSON (`callApi`), for a client that is not the app's page: Sanoma
 * Cloud's connector starts sanoma-ops's workflows here with its bearer token, on a public site's
 * host, where the router leaves this path the app's (`siteRewrite`). A request with an api token
 * (`bearerOf`, as the public login reads it) acts as the token, not as a cookie, so only one
 * without is checked for CSRF, and refused in JSON, as every other answer here is.
 */
export const Route = createFileRoute("/api/call")({
  server: {
    middleware: [
      createCsrfMiddleware({
        filter: ({ request }) => bearerOf(request) === undefined,
        failureResponse: () =>
          Response.json(
            { error: "A request without an api token names this host's own origin in Origin" },
            { status: 403 },
          ),
      }),
    ],
    handlers: { POST: ({ request, context }) => postCall(request, context) },
  },
});
