import { createSerializationAdapter } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { actorHeaders } from "./actor.ts";
import { ApiError } from "./api.ts";
import type { RequestContext } from "./context.ts";
import { notInDemo, publicOnly } from "./middleware.ts";
import { actorOf, serverFnFailure } from "./server/core.ts";

declare module "@tanstack/react-router" {
  interface Register {
    // startApp passes this to every handler.fetch; middleware, server functions and loaders on
    // the server all get it as `context.app` (and `context.site` on a public site's host).
    server: { requestContext: RequestContext };
  }
}

/**
 * Says who is asking, when asked: server functions call `context.actor()` (see `actorOf`). On a
 * public site's host, the app is the site's (`AppContext.site`), whose login is its front door.
 */
const actor = createMiddleware().server(({ request, context, next }) =>
  next({ context: { actor: actorOf(context.app, request) } }),
);

/** The page's half: sends the name this browser keeps, URI-encoded so any name fits in a header. */
const actorHeader = createMiddleware({ type: "function" }).client(({ next }) => next({ headers: actorHeaders() }));

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
 * `errorBodyOf`, or with the router's not-found for a read that finds nothing, so the page shows
 * its not-found view (`serverFnFailure`). Start logs "Server Fn Error!" only for what fails
 * outside the function's middleware (it would log a 4xx there too; accepted), so 500s are logged
 * there.
 */
const apiErrors = createMiddleware({ type: "function" }).server(async ({ next, method }) => {
  try {
    return await next();
  } catch (err) {
    const failure = serverFnFailure(err, method);
    if (failure instanceof ApiError) setResponseStatus(failure.status);
    throw failure;
  }
});

export const startInstance = createStart(() => ({
  // Defining start.ts turns off Start's default CSRF protection for server functions, so it is added back here.
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }), actor],
  // `publicOnly` and `notInDemo` inside `apiErrors`, which answers their refusals as every other
  // (a change's status, a read's not-found).
  functionMiddleware: [actorHeader, apiErrors, publicOnly, notInDemo],
  serializationAdapters: [apiErrorTransport],
}));
