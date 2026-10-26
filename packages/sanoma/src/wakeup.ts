import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { startWakeupService, type WakeupRoute } from "@sanoma-ai/workflows/wakeup-service";
import type { Stoppable } from "./serve.ts";

// `sanoma wakeup`: the wakeup service alone, over a plain Node server: its routes and `/healthz`.

export interface WakeupServed extends Stoppable {
  /** Where it listens, such as `http://127.0.0.1:3100`. */
  url: string;
}

/** The route a path falls under: `route.path` itself, or a path under it. */
const routeAt = (routes: readonly WakeupRoute[], path: string) =>
  routes.find((route) => path === route.path || path.startsWith(`${route.path}/`));

/** `req` as a fetch `Request`, its body read whole. */
async function requestOf(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of [value ?? []].flat()) headers.append(name, one);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(new URL(req.url ?? "/", origin), { method, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body: Buffer.concat(chunks) });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

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
    requestOf(req, "http://wakeup")
      .then((request) => route.handle(request))
      .then((response) => send(res, response))
      .catch((err: unknown) => {
        log(`sanoma wakeup: a request failed: ${err instanceof Error ? err.message : String(err)}`);
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
