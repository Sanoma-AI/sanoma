import { createSerializationAdapter, notFound } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { loadActor } from "./actor.ts";
import { ACTOR_HEADER, ApiError } from "./api.ts";
import type { AppContext } from "./context.ts";
import { toApiError } from "./server/core.ts";

declare module "@tanstack/react-router" {
  interface Register {
    // startApp passes this to every handler.fetch; middleware, server routes, server functions
    // and loaders on the server all get it as `context.app`.
    server: { requestContext: { app: AppContext } };
  }
}

/** Says who is asking, once per request: routes and server functions read `context.actor`. */
const actor = createMiddleware().server(async ({ request, context, next }) =>
  next({ context: { actor: await context.app.resolveActor(request) } }),
);

/** The page's half: sends the name this browser keeps, URI-encoded so any name fits in a header. */
const actorHeader = createMiddleware({ type: "function" }).client(({ next }) => {
  const name = loadActor();
  return next(name ? { headers: { [ACTOR_HEADER]: encodeURIComponent(name) } } : {});
});

/**
 * Start sends any other error to the browser as its message alone, so an ApiError gets its own
 * adapter: it arrives as an ApiError, with `status` and `body`.
 */
const apiErrorTransport = createSerializationAdapter({
  key: "sanoma/ApiError",
  test: (value): value is ApiError => value instanceof ApiError,
  toSerializable: ({ status, body }) => ({ status, body }),
  fromSerializable: ({ status, body }) => new ApiError(status, body),
});

/**
 * Every server function fails with an ApiError and its status, which the page reads with
 * `errorBodyOf`. A read that finds nothing is the router's not-found instead, so the page
 * shows its not-found view. Start logs "Server Fn Error!" only for what fails outside the
 * function's middleware (it would log a 4xx there too; accepted), so 500s are logged here.
 */
const apiErrors = createMiddleware({ type: "function" }).server(async ({ next, method }) => {
  try {
    return await next();
  } catch (err) {
    const api = toApiError(err, "a server function");
    if (api.status === 404 && method === "GET") throw notFound();
    setResponseStatus(api.status);
    throw api;
  }
});

export const startInstance = createStart(() => ({
  // Defining start.ts turns off Start's default CSRF protection for server functions, so it is added back here.
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }), actor],
  functionMiddleware: [actorHeader, apiErrors],
  serializationAdapters: [apiErrorTransport],
}));
