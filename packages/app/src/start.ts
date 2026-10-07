import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { hostName, isLoopback, refuseHost } from "./loopback.ts";

/**
 * When the app listens on this machine only, a page elsewhere could still reach it by pointing
 * its own host name at 127.0.0.1 (DNS rebinding). Its requests then carry that name in Host,
 * so anything not addressed to a loopback name is refused, page, API and server functions alike.
 */
const loopbackOnly = createMiddleware().server(({ request, next, context }) => {
  const host = request.headers.get("host") ?? "";
  if (context.app.loopbackOnly && !isLoopback(hostName(host))) return refuseHost(host);
  return next();
});

export const startInstance = createStart(() => ({
  // Defining start.ts turns off Start's default CSRF protection for server functions, so it is added back here.
  requestMiddleware: [loopbackOnly, createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })],
}));
