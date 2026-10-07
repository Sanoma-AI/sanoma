import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** True for localhost, 127.x.x.x and ::1. */
export const isLoopback = (host: string) => LOOPBACK_NAMES.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** The host name in a Host header (`name`, `name:port`, `[v6]:port`), lowercased. */
export function hostName(header: string): string {
  const name = header.startsWith("[") ? header.slice(1, header.indexOf("]")) : header.replace(/:\d*$/, "");
  return name.toLowerCase();
}

/**
 * When the app listens on this machine only, a page elsewhere could still reach it by pointing
 * its own host name at 127.0.0.1 (DNS rebinding). Its requests then carry that name in Host,
 * so anything not addressed to a loopback name is refused, page, API and server functions alike.
 */
const loopbackOnly = createMiddleware().server(({ request, next, context }) => {
  const host = request.headers.get("host") ?? "";
  if (context.app.loopbackOnly && !isLoopback(hostName(host))) {
    return Response.json(
      { error: `This app answers to localhost only, not ${host || "a request with no Host"}` },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  return next();
});

export const startInstance = createStart(() => ({
  // Defining start.ts turns off Start's default CSRF protection for server functions, so it is added back here.
  requestMiddleware: [loopbackOnly, createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" })],
}));
