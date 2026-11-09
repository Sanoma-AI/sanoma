// The Node adapter: serves the app's handler (`appHandler`) over Node's `http`, locally and in
// `sanoma serve`. It makes what the handler is given from where the files are: the snapshot
// (`liveSnapshot`, made again once a file changed), the client, the public sites' logins, the
// built client's files (or Vite's dev server), and the checkout the repository's actions work in.
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLIENT_IP_HEADER,
  errorMessage,
  isLoopback,
  type LoginHalf,
  problemLine,
  warningLine,
  type ResolvedConfig,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type SocialClients,
  type Source,
} from "sanoma/workflows";
import type { SiteEntry } from "sanoma/workflows/describe";
import { siteDir } from "sanoma/workflows/shared";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import { STYLESHEET_FILE } from "./content-files.ts";
import type { AdmittingLogin, LoginProvider, ServerEntry } from "./context.ts";
import { appHandler, type AppHandlerOptions, type IngressRoute, localHost } from "./handler.ts";
import { admitting } from "./login/admission.ts";
import { publicFront, servedOnceMade, siteLogin } from "./login/public.ts";
import { loopbackLogin } from "./loopback.ts";
import { type AppSnapshot, siteFileBroken } from "./snapshot.ts";
import { liveSnapshot } from "./snapshot-build.ts";

export { ACTOR_HEADER } from "./api.ts";
export type { LoginProvider, ResolveActor } from "./context.ts";
export type { IngressRoute } from "./handler.ts";
export { type MakeStaffLogin, type StaffSocial, staffLogin } from "./login/staff.ts";
export { loopbackLogin } from "./loopback.ts";
export type { AppBundle, AppBundleContext, AppBundleEnv, AppBundleModule, AppHost } from "./app-bundle.ts";

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
  /**
   * A public site's domain, by site name (`www: "sanoma.example"`): the app serves the site at the
   * root of that host, as it does at `<name>.localhost`. One naming a site that is missing or not
   * public is warned about and not served.
   */
  domains?: Record<string, string>;
  /**
   * The company's own OAuth clients (its GitHub App's), given to each public site's login
   * (`LoginContext.social`), which then offers them to visitors. The staff login takes its own
   * (`staffLogin(make, social)`).
   */
  social?: SocialClients;
  /**
   * Machine routes, answered right after `/healthz` and ahead of the public sites and the login,
   * at any host name: a request whose path is exactly `path` is answered by `handle`, or with 405
   * when `method` is given and the request's is another. One route per path, never `/healthz`.
   * Nothing checks who is asking, so each checks its own token; never give one a page's path.
   * Besides these, the app answers `POST /webhooks/<vendor>` for each connector's remote half that
   * reads webhooks (`remoteWebhook`).
   */
  ingress?: readonly IngressRoute[];
  /**
   * Called right after each change a worker must run that the app makes commits: a run's start
   * (drift, apply and a held call are starts) and an approval's decision; never for a read
   * (`ClientOptions.onWrite`). `sanoma serve` wakes its worker with it (`Supervisor.wake`). Must
   * not throw.
   */
  onWrite?: () => void;
}

export interface App {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
  /** Each public site served, by name, at its own host on this machine: `http://<name>.localhost:<port>`. */
  sites: Record<string, string>;
  close(): Promise<void>;
}

/**
 * Serves the app over a config on Node: its runs, their ledgers and approvals, and a form to start
 * each workflow, from the company's files where they are. Reads the same config the worker runs,
 * through Postgres and the config's ledger store; it runs no workflows itself. Refuses, at once, a
 * config the worker would refuse; missing credentials refuse nothing, and the connector pages
 * show and set them; data files with problems it warns about and leaves out (the Hosting page
 * lists them).
 */
export async function startApp(config: SanomaConfig, options: AppOptions = {}): Promise<App> {
  const host = options.host ?? "127.0.0.1";
  const given = options.login ?? loopbackLogin();
  given.check(host);
  if (options.dev && !isLoopback(host)) {
    throw new Error(`The dev server listens on this machine only, not ${host}: serve a build there`);
  }
  const resolved = resolveConfig(config);
  const live = await liveSnapshot(config, { ...(options.source && { source: options.source }) });
  const current = await live();
  warnProblems(resolved, current);
  // The build first, importing nothing and connecting to nothing: a missing or half build is
  // refused before anything is opened. The dev server has nothing built to check.
  const sockets = new WeakMap<Request, { req: IncomingMessage; res: ServerResponse }>();
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      console.error("sanoma app: request failed:", err);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });
  const [loaded, connected] = await Promise.allSettled([
    options.dev
      ? devResponder(options.dev, server, sockets)
      : builtResponder(resolve(options.distDir ?? defaultDistDir())),
    SanomaClient.connect(config, { onWrite: options.onWrite }),
  ]);
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
  // The people as the files say now, so a person taken out is refused at their next request.
  const login = admitting(given, async () => (await live()).people);
  // Each public site served, by name, with its own front door: its login half, if it has one,
  // made once the app listens (`halves`). A public site whose site.ts has a problem is not
  // served, as its login could be one not read.
  const halves = new Map<SiteEntry, PromiseWithResolvers<LoginHalf>>();
  const sites = new Map<string, AdmittingLogin>();
  for (const site of current.description.sites) {
    if (!site.public) continue;
    if (siteFileBroken(site)) {
      console.warn(
        `sanoma app: ${siteDir(site.name)}/site.ts has a problem: the site is served on no host until it is fixed`,
      );
      continue;
    }
    const half = site.login === undefined ? undefined : Promise.withResolvers<LoginHalf>();
    if (half) halves.set(site, half);
    sites.set(
      site.name,
      publicFront(site, half?.promise, (token) => client.tokens.resolve(token)),
    );
  }
  const app = appHandler(
    {
      resolved,
      snapshot: live,
      client,
      login,
      sites,
      ...(options.domains && { domains: options.domains }),
      ...(options.ingress && { ingress: options.ingress }),
      entry: responder.entry,
      files: responder.files,
      ...(responder.stylesheet && { stylesheet: responder.stylesheet }),
    },
    current,
  );

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // The visitor's address, from the socket alone, for a login's rate limits: never a client's copy.
    req.headers[CLIENT_IP_HEADER] = req.socket.remoteAddress ?? "";
    const request = new NodeRequest({ req, res });
    sockets.set(request, { req, res });
    const response = await app.fetch(request);
    // Vite's dev server answered on the socket itself.
    if (res.headersSent) return void (await response.body?.cancel());
    await sendNodeResponse(res, response);
  }

  try {
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        done();
      });
    });
    // The staff login, once there is a client and the files it admits by; a login that cannot start stops the app.
    await given.open?.(app.context);
  } catch (err) {
    if (server.listening) await new Promise((done) => server.close(done));
    await responder.close();
    await closeQuietly(client);
    throw err;
  }
  // The sites' logins, with the client and the files: one that fails (its key, its config) is
  // logged, and its site is served on no host (503), so the app starts and the environment
  // (`SANOMA_SIGNING_KEY`, which each login's key is derived from) can give what it lacks.
  await Promise.all(
    [...halves].map(async ([site, half]) => {
      const domain = app.domains.get(site.name);
      const origins = [`http://${localHost(site.name)}:*`, ...(domain ? [`https://${domain}`] : [])];
      half.resolve(siteLogin(resolved, client, site, origins, options.social));
      await servedOnceMade(sites, site, half.promise, "sanoma app");
    }),
  );

  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address)}:${address.port}`,
    sites: Object.fromEntries([...sites.keys()].map((name) => [name, `http://${localHost(name)}:${address.port}`])),
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
          await given
            .close?.()
            .catch((err: unknown) => console.error("sanoma app: closing the login also failed:", err));
          await closeQuietly(client);
        }
      })();
      return closing;
    },
  };
}

/**
 * Says what is wrong in the files, without stopping the app: a data file's resources are left out
 * (the Hosting page lists the problems), a workflow the worker will refuse is shown with its
 * outline's error, and a site's call to what the config lacks fails when it is made.
 */
function warnProblems(resolved: ResolvedConfig, { description }: AppSnapshot): void {
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
  const warnings = description.sites.flatMap((site) => site.warnings.map((w) => `  ${warningLine(w)}`));
  if (warnings.length)
    console.warn(`sanoma app: warnings in the sites (\`sanoma check\` lists them):\n${warnings.join("\n")}`);
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
  new Error(`The app is not built: ${path} is missing. Run \`pnpm --filter sanoma build\` first.`);

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

/** What answers what the handler lets through: the host's files, then Start's entry. */
interface Responder extends Pick<AppHandlerOptions, "entry" | "files" | "stylesheet"> {
  /** Closes what it opened, logging a failure rather than throwing it, as `closeQuietly`. */
  close(): Promise<void>;
}

/** The build at `distDir`: its client's files, the kit's stylesheet, and its server entry. */
async function builtResponder(distDir: string): Promise<Responder> {
  const files = await staticFiles(join(distDir, "client"));
  // The kit's theme, which the root route imports as `style.css?url`: what the login's own pages
  // link, as the build named it. A build without the file (an older one) leaves the pages unstyled.
  const stylesheet = await readFile(join(distDir, STYLESHEET_FILE), "utf8").then(
    (text) => {
      const path = JSON.parse(text) as unknown;
      return typeof path === "string" && files.has(path) ? path : undefined;
    },
    (err: unknown) => {
      if (!isMissing(err)) throw err;
      return undefined;
    },
  );
  const serverEntry = join(distDir, "server", "server.js");
  await mustBeFile(serverEntry);
  const entry = await loadServerEntry(serverEntry);
  return {
    entry,
    files: async (request) => {
      const file = staticFile(files, request);
      if (!file) return undefined;
      const body = request.method === "HEAD" ? null : (Readable.toWeb(createReadStream(file.path)) as ReadableStream);
      return new Response(body, { headers: file.headers });
    },
    ...(stylesheet && { stylesheet }),
    close: async () => {},
  };
}

/**
 * Vite's dev server (`appDevServer`, loaded only here), then Start's entry as it imports it now:
 * Vite's own answers (modules, the HMR client, files) are written to the request's socket.
 */
async function devResponder(
  { repo, onFileChange }: NonNullable<AppOptions["dev"]>,
  server: ReturnType<typeof createServer>,
  sockets: WeakMap<Request, { req: IncomingMessage; res: ServerResponse }>,
): Promise<Responder> {
  const { appDevServer } = await import("./build.ts");
  const dev = await appDevServer(repo, server, onFileChange);
  return {
    files: (request) =>
      new Promise((done, fail) => {
        const { req, res } = sockets.get(request)!;
        // Vite answers what it serves itself without calling next; the adapter then sends nothing.
        res.once("close", () => done(new Response(null)));
        dev.middlewares(req, res, (err) => (err ? fail(err) : done(undefined)));
      }),
    entry: { fetch: async (request, opts) => (await dev.serverEntry()).fetch(request, opts) },
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
  headers: Record<string, string>;
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
        "content-length": String((await stat(path)).size),
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
function staticFile(files: Map<string, StaticFile>, request: Request): StaticFile | undefined {
  const { pathname } = new URL(request.url);
  if ((request.method !== "GET" && request.method !== "HEAD") || pathname.startsWith("/_serverFn/")) return undefined;
  try {
    return files.get(decodeURIComponent(pathname));
  } catch {
    return undefined;
  }
}

function urlHost({ address, family }: AddressInfo): string {
  if (address === "0.0.0.0" || address === "::") return "localhost";
  return family === "IPv6" ? `[${address}]` : address;
}
