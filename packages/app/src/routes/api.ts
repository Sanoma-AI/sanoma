import { createFileRoute } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { errorResponse, isRouterAnswer } from "../server/core.ts";

/** Every /api route answers a failure as JSON: an ApiError's status and body, or a logged 500. */
const jsonErrors = createMiddleware().server(async ({ request, pathname, next }) => {
  try {
    return await next();
  } catch (err) {
    if (isRouterAnswer(err)) throw err;
    return errorResponse(err, `${request.method} ${pathname}`);
  }
});

export const Route = createFileRoute("/api")({
  server: { middleware: [jsonErrors] },
});
