import { createFileRoute } from "@tanstack/react-router";
import { createCsrfMiddleware } from "@tanstack/react-start";
import { bearerOf } from "../../login/public.ts";
import { postCall } from "../../server/core.ts";

/**
 * A site's `api` over plain JSON (`callApi`), for a client that is not the app's page: Sanoma
 * Cloud's connector starts sanoma-ops's workflows here with its bearer token, on a public site's
 * host, where the router leaves this path the app's (`siteRewrite`). A request with an api token
 * (`bearerOf`, as the public login reads it) acts as the token, not as a cookie, so only a POST
 * without one is checked for CSRF; every refusal is JSON, any other method a 405.
 */
export const Route = createFileRoute("/api/call")({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: {
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
          handler: ({ request, context }) => postCall(request, context),
        },
        ANY: () => Response.json({ error: "/api/call answers POST only" }, { status: 405, headers: { allow: "POST" } }),
      }),
  },
});
