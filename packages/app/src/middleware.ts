import { createMiddleware } from "@tanstack/react-start";
import { type ActorContext, requireActor } from "./server/core.ts";

// Who makes a change, checked once for every change: attached to each server function and API
// handler that makes one, not to every request, since a read needs no one.
//
// start.ts's global `actor` middleware gives every request's context `actor`, but Start types a
// middleware made apart from createStart without the global ones (its `createMiddleware` is
// bound to an empty Register), so the context is named as an ActorContext here.

/** Who is making the change, as `context.principal`, or a 400 when nobody is named (see requireActor). */
export const withPrincipal = createMiddleware({ type: "function" }).server(async ({ context, next }) =>
  next({ context: { principal: await requireActor(context as ActorContext) } }),
);

/** `withPrincipal`, for a server route's handler. */
export const withPrincipalRoute = createMiddleware().server(async ({ context, next }) =>
  next({ context: { principal: await requireActor(context as ActorContext) } }),
);
