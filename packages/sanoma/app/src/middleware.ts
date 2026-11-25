import { createMiddleware } from "@tanstack/react-start";
import { ApiError } from "./api.ts";
import { PUBLIC_FNS } from "./public-fns.ts";
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
 * On a public site's host (`AppContext.site`) only `PUBLIC_FNS` answer, each matched by its name and
 * its file: any other is a 404, as if it were not there. Start names a server function's file from
 * the build's root, with `/` on every platform. Only a company's build serves a site's host (on Node,
 * on its dev server, in the Worker's bundle), and its root is the repo, so the app's file there ends
 * in `/sanoma/app/src/functions.ts`, under `node_modules` or a checkout's `packages/`.
 */
export const publicOnly = createMiddleware({ type: "function" }).server(({ next, context, serverFnMeta }) => {
  const file = PUBLIC_FNS.get(serverFnMeta.name);
  const answers = file !== undefined && serverFnMeta.filename.endsWith(`/${file}`);
  if ((context as unknown as { app: AppContext }).app.site !== undefined && !answers) {
    throw new ApiError(404, { error: "Not found" });
  }
  return next();
});
