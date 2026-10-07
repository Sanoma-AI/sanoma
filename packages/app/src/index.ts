import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeConfig, resolveConfig, SanomaClient, type SanomaConfig } from "@sanoma/workflows";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import type { AppContext, ResolveActor } from "./context.ts";
import { actorFromHeader } from "./default-actor.ts";
import { hostName, isLoopback, refuseHost } from "./loopback.ts";

export {
  ACTOR_HEADER,
  approverName,
  DecideRequest,
  errorBodyOf,
  type ErrorResponse,
  type InputIssue,
  type RunDetail,
  StartRunRequest,
  type StartRunResponse,
} from "./api.ts";
export type { ResolveActor } from "./context.ts";

export interface AppOptions {
  /** Defaults to 0: any free port, which `App.url` reports. 4321 is the suggested fixed port. */
  port?: number;
  /**
   * Defaults to 127.0.0.1, so only this machine can reach the app. There is no login:
   * anyone who can reach it can start runs and decide approvals as any name.
   */
  host?: string;
  /**
   * Says who is making a request. Defaults to the name in the `x-sanoma-actor` header, which
   * the page sends; a hosted deployment passes its own, reading its login.
   */
  resolveActor?: ResolveActor;
  /** The built app (`client/` and `server/`). Defaults to the one this package ships. */
  distDir?: string;
}

export interface App {
  /** Where the app listens, such as `http://127.0.0.1:4321`. */
  url: string;
  close(): Promise<void>;
}

interface ServerEntry {
  fetch(request: Request, opts?: { context?: { app: AppContext } }): Response | Promise<Response>;
}

/**
 * Serves the web UI and JSON API over a config: its runs, their ledgers and approvals, and a
 * form to start each workflow. Reads the same config the worker runs, through Postgres and the
 * config's ledger store; it runs no workflows itself. Refuses, at once, a config the worker
 * would refuse.
 */
export async function startApp(config: SanomaConfig, options: AppOptions = {}): Promise<App> {
  const resolved = resolveConfig(config);
  const description = describeConfig(config);
  const distDir = resolve(options.distDir ?? defaultDistDir());
  const entry = await loadServerEntry(distDir);
  const clientDir = join(distDir, "client");
  const host = options.host ?? "127.0.0.1";

  const client = await SanomaClient.connect(config);
  const app: AppContext = {
    resolved,
    description,
    client,
    resolveActor: options.resolveActor ?? actorFromHeader,
    loopbackOnly: isLoopback(host),
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error("sanoma app: request failed:", err);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Static files are answered here, before Start sees the request, so the Host rule runs here too.
    if (app.loopbackOnly && !isLoopback(hostName(req.headers.host ?? ""))) {
      return sendNodeResponse(res, refuseHost(req.headers.host ?? ""));
    }
    if (await serveStatic(clientDir, req, res)) return;
    const request = new NodeRequest({ req, res });
    await sendNodeResponse(res, await entry.fetch(request, { context: { app } }));
  }

  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        done();
      });
    });
  } catch (err) {
    await client.close();
    throw err;
  }

  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address)}:${address.port}`,
    close() {
      closing ??= (async () => {
        await new Promise<void>((done, fail) => {
          server.close((err) => (err ? fail(err) : done()));
          server.closeAllConnections();
        });
        await client.close();
      })();
      return closing;
    },
  };
}

/** Published, this module is dist/index.js beside dist/server. In the repo it runs from src/, and `vite build` writes ../dist. */
function defaultDistDir(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/" : "./", import.meta.url));
}

async function loadServerEntry(distDir: string): Promise<ServerEntry> {
  const path = join(distDir, "server", "server.js");
  if (!(await isFile(path))) {
    throw new Error(
      `The app is not built: ${path} is missing. Run \`pnpm --filter @sanoma/app build\` (in the sanoma repo) first.`,
    );
  }
  const mod = (await import(pathToFileURL(path).href)) as { default?: ServerEntry };
  if (typeof mod.default?.fetch !== "function") throw new Error(`${path} does not export a { fetch } server entry`);
  return mod.default;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves a file from the built client when the path names one, and says whether it did.
 * Vite names everything under assets/ by content hash, so those never change; anything else
 * is revalidated on every use.
 */
async function serveStatic(clientDir: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://app.invalid").pathname);
  } catch {
    return false;
  }
  if (pathname === "/" || pathname.includes("\0")) return false;
  const file = resolve(clientDir, `.${pathname}`);
  const rel = relative(clientDir, file);
  // Outside the client directory (`..`, an absolute path) is never served.
  if (!rel || rel.startsWith("..") || resolve(clientDir, rel) !== file || !(await isFile(file))) return false;
  const immutable = rel.startsWith(`assets${sep}`);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": (await stat(file)).size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else await pipeline(createReadStream(file), res);
  return true;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function urlHost({ address, family }: AddressInfo): string {
  if (address === "0.0.0.0" || address === "::") return "localhost";
  return family === "IPv6" ? `[${address}]` : address;
}
