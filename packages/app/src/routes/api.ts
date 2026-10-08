import { createFileRoute, isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { errorResponse } from "../server/core.ts";

/** Every /api route answers a failure as JSON: an ApiError's status and body, or a logged 500. */
const jsonErrors = createMiddleware().server(async ({ request, pathname, next }) => {
  try {
    return await next();
  } catch (err) {
    // The router's not-found and redirects are answers, not failures: they go through as thrown.
    if (isNotFound(err) || isRedirect(err)) throw err;
    return errorResponse(err, `${request.method} ${pathname}`);
  }
});

export const Route = createFileRoute("/api")({
  server: { middleware: [jsonErrors] },
});
