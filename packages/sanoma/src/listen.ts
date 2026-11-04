import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { IngressRoute } from "@sanoma-ai/app";
import { errorMessage } from "@sanoma-ai/workflows";
import { NodeRequest, sendNodeResponse } from "srvx/node";

// A plain Node server over a few machine routes, through srvx's Node adapters, as the app's: what
// `sanoma wakeup` and `sanoma worker`'s port serve.

export interface Listening {
  /** Where it listens, such as `http://127.0.0.1:3100`. */
  url: string;
  stop(): Promise<void>;
}

export interface ListenOptions {
  host: string;
  port: number;
  /** Where a request that failed is said, prefixed with `name`. */
  log: (line: string) => void;
  name: string;
}

/** The route a request is for: the one at its path, else the longest `prefix` route over it, as the app's `ingress` matches. */
function routeAt(routes: readonly IngressRoute[], method: string, path: string) {
  const fits = routes.filter((route) => !route.method || route.method === method);
  return (
    fits.find((route) => route.path === path) ??
    fits
      .filter((route) => route.prefix && path.startsWith(`${route.path}/`))
      .toSorted((a, b) => b.path.length - a.path.length)[0]
  );
}

const text = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

/**
 * Serves `routes` on `host` and `port`, and `GET /healthz` (200) for a host's probe; anything else
 * is a 404. Resolves once it listens; `stop` closes it and its connections.
 */
export async function listenRoutes(
  routes: readonly IngressRoute[],
  { host, port, log, name }: ListenOptions,
): Promise<Listening> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return text(res, 200, "ok\n");
    const route = routeAt(routes, req.method ?? "GET", path);
    if (!route) return text(res, 404, "not found\n");
    route
      .handle(new NodeRequest({ req, res }))
      .then((response) => sendNodeResponse(res, response))
      .catch((err: unknown) => {
        log(`${name}: a request failed: ${errorMessage(err)}`);
        if (res.headersSent) res.destroy();
        else text(res, 500, "internal error\n");
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  // As the app names where it listens: any address as localhost, IPv6 in brackets.
  const { address, family, port: bound } = server.address() as AddressInfo;
  const named = address === "0.0.0.0" || address === "::" ? "localhost" : family === "IPv6" ? `[${address}]` : address;
  return {
    url: `http://${named}:${bound}`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
