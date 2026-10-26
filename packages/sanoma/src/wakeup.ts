import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { errorMessage } from "@sanoma-ai/workflows";
import { startWakeupService, type WakeupRoute } from "@sanoma-ai/workflows/wakeup-service";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import type { Stoppable } from "./serve.ts";

// `sanoma wakeup`: the wakeup service alone, over a plain Node server: its routes and `/healthz`.

export interface WakeupServed extends Stoppable {
  /** Where it listens, such as `http://127.0.0.1:3100`. */
  url: string;
}

/** The route a path falls under: `route.path` itself, or a path under it, as the app's `ingress` matches. */
const routeAt = (routes: readonly WakeupRoute[], path: string) =>
  routes.find((route) => path === route.path || path.startsWith(`${route.path}/`));

const text = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

/**
 * Starts the wakeup service on `databaseUrl` and serves it on `host` and `port`: its routes, and
 * `GET /healthz` for a host's probe; anything else is a 404. `stop` closes the server, then the service.
 */
export async function runWakeup(
  databaseUrl: string,
  { host, port, log }: { host: string; port: number; log: (line: string) => void },
): Promise<WakeupServed> {
  const service = await startWakeupService({ databaseUrl, log: { info: log, warn: log } });
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return text(res, 200, "ok\n");
    const route = routeAt(service.routes, path);
    if (!route) return text(res, 404, "not found\n");
    route
      .handle(new NodeRequest({ req, res }))
      .then((response) => sendNodeResponse(res, response))
      .catch((err: unknown) => {
        log(`sanoma wakeup: a request failed: ${errorMessage(err)}`);
        if (res.headersSent) res.destroy();
        else text(res, 500, "internal error\n");
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (err) {
    await service.stop();
    throw err;
  }
  // As the app names where it listens: any address as localhost, IPv6 in brackets.
  const { address, family, port: bound } = server.address() as AddressInfo;
  const named = address === "0.0.0.0" || address === "::" ? "localhost" : family === "IPv6" ? `[${address}]` : address;
  return {
    url: `http://${named}:${bound}`,
    async stop() {
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      } finally {
        await service.stop();
      }
    },
  };
}
