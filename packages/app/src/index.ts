import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  errorMessage,
  isLoopback,
  problemLine,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Source,
} from "@sanoma-ai/workflows";
import { describeConfig, readPeople } from "@sanoma-ai/workflows/describe";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import type { AppContext, LoginProvider, ServerEntry } from "./context.ts";
import { admitting } from "./login/admission.ts";
import { loopbackLogin } from "./loopback.ts";

export { ACTOR_HEADER } from "./api.ts";
export type { LoginProvider, ResolveActor } from "./context.ts";
export { githubLogin, type GithubLoginOptions } from "./login/github.ts";
export { loopbackLogin } from "./loopback.ts";

export interface AppOptions {
  /** Defaults to 0: any free port, which `App.url` reports. 3000 is the suggested fixed port. */
  port?: number;
  /**
   * Defaults to 127.0.0.1, so only this machine can reach the app. Any other host needs a `login`:
   * the default has none, and refuses to listen there.
   */
  host?: string;
  /**
   * Who may use the app and how they sign in. Defaults to `loopbackLogin()`: no login, the name
   * the page sends in the `x-sanoma-actor` header, on this machine only.
   */
  login?: LoginProvider;
  /** The company's repository: Adopt commits the data file it writes through it. Without one, it only writes the file. */
  source?: Source;
  /** The built app (`client/` and `server/`). Defaults to the one this package ships. */
  distDir?: string;
  /**
   * Serves a company repo's app with its sites from Vite's dev server instead of a build: edits
   * to a site or to the app's source show without a restart, and a new site folder is live once
   * it has a route file. On this machine only (the hot updates' websocket bypasses the login).
   * `onFileChange` is called with each file added, changed or removed in the repo (`appDevServer`).
   */
  dev?: { repo: string; onFileChange?: (file: string) => void };
}

export interface App {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
  close(): Promise<void>;
}

/** Answers a request the login let through, a file's or the server entry's. */
interface Responder {
  respond(req: IncomingMessage, res: ServerResponse, request: Request, app: AppContext): Promise<void>;
  /** Closes what it opened, logging a failure rather than throwing it, as `closeQuietly`. */
  close(): Promise<void>;
}

/**
 * Serves the web UI over a config: its runs, their ledgers and approvals, and a form to start
 * each workflow. Reads the same config the worker runs, through Postgres and the
 * config's ledger store; it runs no workflows itself. Refuses, at once, a config the worker
 * would refuse; missing credentials refuse nothing, and the connector pages show and set them;
 * data files with problems it warns about and leaves out (the Resources page lists them).
 */
export async function startApp(config: SanomaConfig, options: AppOptions = {}): Promise<App> {
  const host = options.host ?? "127.0.0.1";
  const given = options.login ?? loopbackLogin();
  given.check(host);
  if (options.dev && !isLoopback(host)) {
    throw new Error(`The dev server listens on this machine only, not ${host}: serve a build there`);
  }
  const resolved = resolveConfig(config);
  const login = admitting(given, () => readPeople(resolved.root));
  const description = describeConfig(config);
  // Problems in the files do not stop the app: a data file's resources are left out (the Resources
  // page lists the problems), a workflow the worker will refuse is shown with its outline's error,
  // and a site's call to what the config lacks fails when it is made.
  const lines = new Set([
    // The policies refuse every call and start until these are fixed.
    ...resolved.policyProblems,
    ...description.problems.map(problemLine),
    ...description.workflows.flatMap((wf) => wf.problems.map((p) => problemLine({ file: wf.file, ...p }))),
    ...description.sites.flatMap((site) => site.problems.map(problemLine)),
  ]);
  if (lines.size) {
    const list = [...lines].map((line) => `  ${line}`).join("\n");
    console.warn(`sanoma app: the config's files have problems (\`sanoma check\` lists them):\n${list}`);
  }
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
    // A host's probe, before the login: it says the app answers, and nothing else.
    if (req.url?.split("?")[0] === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return void res.end(req.method === "HEAD" ? undefined : "ok\n");
    }
    const request = new NodeRequest({ req, res });
    // Then the login sees every request (pages, server functions and static files alike): its
    // own routes, and any it will not let through.
    const answer = await login.handle?.(request);
    if (answer) return sendNodeResponse(res, answer);
    await responder.respond(req, res, request, app);
  }

  // The build first, importing nothing and connecting to nothing: a missing or half build is
  // refused before anything is opened. The dev server has nothing built to check.
  let load: () => Promise<Responder>;
  if (options.dev) {
    const { repo, onFileChange } = options.dev;
    load = () => devResponder(repo, server, onFileChange);
  } else {
    const distDir = resolve(options.distDir ?? defaultDistDir());
    const files = await staticFiles(join(distDir, "client"));
    const serverEntry = join(distDir, "server", "server.js");
    await mustBeFile(serverEntry);
    load = async () => builtResponder(files, await loadServerEntry(serverEntry));
  }
  const [loaded, connected] = await Promise.allSettled([load(), SanomaClient.connect(config)]);
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
  if (connected.status === "rejected") {
    await loaded.value.close();
    throw connected.reason;
  }
  const responder = loaded.value;
  const client = connected.value;
  const app: AppContext = { resolved, description, client, login, source: options.source };

  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        done();
      });
    });
  } catch (err) {
    await responder.close();
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
          // Together: the server waits for upgraded sockets (the dev server's websocket), which
          // only the responder's close ends.
          await Promise.all([
            new Promise<void>((done, fail) => {
              server.close((err) => (err ? fail(err) : done()));
              server.closeAllConnections();
            }),
            responder.close(),
          ]);
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
  new Error(`The app is not built: ${path} is missing. Run \`pnpm --filter @sanoma-ai/app build\` first.`);

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

/** The build's files, then its server entry. */
const builtResponder = (files: Map<string, StaticFile>, entry: ServerEntry): Responder => ({
  async respond(req, res, request, app) {
    const file = staticFile(files, req);
    if (file) return sendFile(file, req, res);
    await sendNodeResponse(res, await entry.fetch(request, { context: { app } }));
  },
  close: async () => {},
});

/** Vite's dev server (`appDevServer`, loaded only here), then Start's entry as it imports it now. */
async function devResponder(repo: string, server: Server, onFileChange?: (file: string) => void): Promise<Responder> {
  const { appDevServer } = await import("./build.ts");
  const dev = await appDevServer(repo, server, onFileChange);
  return {
    respond: (req, res, request, app) =>
      new Promise((done, fail) => {
        // Vite answers what it serves itself without calling next.
        res.once("close", done);
        dev.middlewares(req, res, (err) => {
          if (err) return fail(err);
          dev
            .serverEntry()
            .then(async (entry) => sendNodeResponse(res, await entry.fetch(request, { context: { app } })))
            .then(done, fail);
        });
      }),
    close: () =>
      dev.close().catch((err: unknown) => console.error("sanoma app: closing the dev server also failed:", err)),
  };
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

/** The built file a request names, if any. Server functions are never files. */
function staticFile(files: Map<string, StaticFile>, req: IncomingMessage): StaticFile | undefined {
  const url = req.url ?? "/";
  if ((req.method !== "GET" && req.method !== "HEAD") || url.startsWith("/_serverFn/")) {
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
