import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorMessage, resolveConfig, SanomaClient, type SanomaConfig } from "@sanoma/workflows";
import { describeConfig } from "@sanoma/workflows/describe";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import type { AppContext, ResolveActor } from "./context.ts";
import { hostName, isLoopback, refuseHost } from "./loopback.ts";

export { ACTOR_HEADER, type ErrorResponse, type InputIssue, type RunDetail, type StartRunResponse } from "./api.ts";
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
 * would refuse; data files with problems it warns about and leaves out (`/api/config` lists them).
 */
export async function startApp(config: SanomaConfig, options: AppOptions = {}): Promise<App> {
  const resolved = resolveConfig(config);
  const description = describeConfig(config);
  // Broken data files do not stop the app: it shows the resources it could read, and the problems.
  if (description.problems.length) {
    const lines = description.problems.map((p) => `  ${p.file ? `${p.file}:${p.line}:${p.column}: ` : ""}${p.message}`);
    console.warn(`sanoma app: the data files have problems; their resources are left out:\n${lines.join("\n")}`);
  }
  const distDir = resolve(options.distDir ?? defaultDistDir());
  const host = options.host ?? "127.0.0.1";
  const loopbackOnly = isLoopback(host);

  // The build first, importing nothing and connecting to nothing: a missing or half build is
  // refused before anything is opened.
  const files = await staticFiles(join(distDir, "client"));
  const serverEntry = join(distDir, "server", "server.js");
  await mustBeFile(serverEntry);
  const [loaded, connected] = await Promise.allSettled([loadServerEntry(serverEntry), SanomaClient.connect(config)]);
  if (loaded.status === "rejected" && connected.status === "rejected") {
    throw new AggregateError(
      [loaded.reason, connected.reason],
      `The app could not start: ${errorMessage(loaded.reason)}; and ${errorMessage(connected.reason)}`,
    );
  }
  if (loaded.status === "rejected") {
    if (connected.status === "fulfilled") await closeQuietly(connected.value);
    throw loaded.reason;
  }
  if (connected.status === "rejected") throw connected.reason;
  const entry = loaded.value;
  const client = connected.value;
  const app: AppContext = { resolved, description, client, resolveActor: options.resolveActor };

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
    // When the app listens on this machine only, a page elsewhere could still reach it by
    // pointing its own host name at 127.0.0.1 (DNS rebinding). Its requests then carry that
    // name in Host, so anything not addressed to a loopback name is refused: here, where every
    // request passes (pages, API, server functions and static files alike).
    if (loopbackOnly && !isLoopback(hostName(req.headers.host ?? ""))) {
      return sendNodeResponse(res, refuseHost(req.headers.host ?? ""));
    }
    const file = staticFile(files, req);
    if (file) return sendFile(file, req, res);
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
    await closeQuietly(client);
    throw err;
  }

  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address)}:${address.port}`,
    close() {
      closing ??= (async () => {
        try {
          await new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          });
        } finally {
          await closeQuietly(client);
        }
      })();
      return closing;
    },
  };
}

/**
 * Closes the client, logging a failure rather than throwing it: it would replace the error that
 * made startApp or close() stop, which is the one the caller needs.
 */
const closeQuietly = (client: SanomaClient) =>
  client.close().catch((err: unknown) => console.error("sanoma app: closing the client also failed:", err));

/** Published, this module is dist/index.js beside dist/server. In the repo it runs from src/, and `vite build` writes ../dist. */
function defaultDistDir(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/" : "./", import.meta.url));
}

/** What startApp says when the build it serves is missing, in part or whole. */
const notBuilt = (path: string) =>
  new Error(`The app is not built: ${path} is missing. Run \`pnpm --filter @sanoma/app build\` first.`);

/** True for the errors that mean a path is not there: missing, or under something that is not a directory. */
const isMissing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Refuses a build whose file at `path` is not there. */
async function mustBeFile(path: string) {
  const found = await stat(path).then(
    (s) => s.isFile(),
    (err: unknown) => {
      if (isMissing(err)) return false;
      throw err;
    },
  );
  if (!found) throw notBuilt(path);
}

async function loadServerEntry(path: string): Promise<ServerEntry> {
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

interface StaticFile {
  path: string;
  headers: Record<string, string | number>;
}

/**
 * The built client's files by URL path, read once at boot: the build does not change while the
 * app runs, and only a file found here is ever served. Vite names everything under assets/ by
 * content hash, so those never change; anything else is revalidated on every use.
 */
async function staticFiles(clientDir: string): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  const entries = await readdir(clientDir, { recursive: true, withFileTypes: true }).catch((err: unknown) => {
    // Served without its client files, every page would load with no script or style.
    throw isMissing(err) ? notBuilt(clientDir) : err;
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(clientDir, path).split(sep).join("/");
    files.set(`/${rel}`, {
      path,
      headers: {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        "content-length": (await stat(path)).size,
        "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  }
  // An empty directory is as unbuilt as a missing one.
  if (files.size === 0) throw notBuilt(clientDir);
  return files;
}

/** The built file a request names, if any. The API and server functions are never files. */
function staticFile(files: Map<string, StaticFile>, req: IncomingMessage): StaticFile | undefined {
  const url = req.url ?? "/";
  if ((req.method !== "GET" && req.method !== "HEAD") || url.startsWith("/api/") || url.startsWith("/_serverFn/")) {
    return undefined;
  }
  const query = url.indexOf("?");
  try {
    return files.get(decodeURIComponent(query === -1 ? url : url.slice(0, query)));
  } catch {
    return undefined;
  }
}

async function sendFile(file: StaticFile, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, file.headers);
  if (req.method === "HEAD") res.end();
  else await pipeline(createReadStream(file.path), res);
}

function urlHost({ address, family }: AddressInfo): string {
  if (address === "0.0.0.0" || address === "::") return "localhost";
  return family === "IPv6" ? `[${address}]` : address;
}
