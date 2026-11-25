import { createMiddleware } from "@tanstack/react-start";
import { ApiError } from "./api.ts";
import { PUBLIC_FNS, PUBLIC_FNS_FILE } from "./public-fns.ts";
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
 * On a public site's host (`AppContext.site`) only `PUBLIC_FNS` answer, matched by name and by the
 * end of their file's path: any other is a 404, as if it were not there. Start names the file from
 * the build's root with `/`, so a package folder at the root itself has no `/` before it. Only a
 * company's build serves a site's host, and its root is the repo.
 */
export const publicOnly = createMiddleware({ type: "function" }).server(({ next, context, serverFnMeta }) => {
  if (
    (context as unknown as { app: AppContext }).app.site !== undefined &&
    !(PUBLIC_FNS.has(serverFnMeta.name) && `/${serverFnMeta.filename}`.endsWith(PUBLIC_FNS_FILE))
  ) {
    throw new ApiError(404, { error: "Not found" });
  }
  return next();
});
