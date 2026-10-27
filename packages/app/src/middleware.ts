import { createMiddleware } from "@tanstack/react-start";
import { ApiError } from "./api.ts";
import type { AppContext } from "./context.ts";
import { type ActorContext, requireActor } from "./server/core.ts";

// Who makes a change, checked once for every change: attached to each server function that
// makes one, not to every request, since a read needs no one. And which server functions a
// public site's host answers, among start.ts's global ones.
//
// start.ts's global `actor` middleware gives every request's context `actor`, but Start types a
// middleware made apart from createStart without the global ones (its `createMiddleware` is
// bound to an empty Register), so the context is named here.

/** Who is making the change, as `context.principal`, or a 400 when nobody is named (see requireActor). */
export const withPrincipal = createMiddleware({ type: "function" }).server(async ({ context, next }) =>
  next({ context: { principal: await requireActor(context as unknown as ActorContext) } }),
);

/**
 * The server functions a demo refuses (`AppContext.demo`): what would outlast its hourly reseed,
 * a credential or a token stored, a data file adopted, going live. Its runs, decisions and
 * records are the demo itself, and the reseed starts them afresh.
 */
export const DEMO_REFUSED: ReadonlySet<string> = new Set([
  "adoptFn",
  "setCredentialFn",
  "clearCredentialFn",
  "setSetupTokenFn",
  "goLiveFn",
  "goLiveHostFn",
  "connectExistingFn",
]);

/** In a demo, `DEMO_REFUSED` are a 403 saying why. */
export const notInDemo = createMiddleware({ type: "function" }).server(({ next, context, serverFnMeta }) => {
  if ((context as unknown as { app: AppContext }).app.demo && DEMO_REFUSED.has(serverFnMeta.name)) {
    throw new ApiError(403, { error: "This is a demo: nothing done here is kept, so this cannot be done here" });
  }
  return next();
});

/** The server functions a public site's host answers: a site's `api`, and who is asking. */
export const PUBLIC_FNS: ReadonlySet<string> = new Set(["callFn", "getActor"]);

/** On a public site's host (`AppContext.site`) only `PUBLIC_FNS` answer: any other is a 404, as if it were not there. */
export const publicOnly = createMiddleware({ type: "function" }).server(({ next, context, serverFnMeta }) => {
  if ((context as unknown as { app: AppContext }).app.site !== undefined && !PUBLIC_FNS.has(serverFnMeta.name)) {
    throw new ApiError(404, { error: "Not found" });
  }
  return next();
});
