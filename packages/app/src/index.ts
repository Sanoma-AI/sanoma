import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CLIENT_IP_HEADER,
  errorMessage,
  isLoopback,
  type LoginHalf,
  problemLine,
  warningLine,
  readPolicyFiles,
  type ResolvedConfig,
  resolveConfig,
  SanomaClient,
  type SanomaConfig,
  type Source,
} from "@sanoma-ai/workflows";
import { type ConfigDescription, describeConfig, readPeople, type SiteEntry } from "@sanoma-ai/workflows/describe";
import { siteDir } from "@sanoma-ai/workflows/shared";
import { NodeRequest, sendNodeResponse } from "srvx/node";
import type { AppContext, LoginProvider, RequestContext, ServerEntry } from "./context.ts";
import { admitting } from "./login/admission.ts";
import { demoLogin } from "./login/demo.ts";
import { loginKey } from "./login/keys.ts";
import { publicFront } from "./login/public.ts";
import { hostName, loopbackLogin, placeOf } from "./loopback.ts";
import { type Published, PUBLISHED_FILE, publishedOf } from "./content-files.ts";
import { seoFile } from "./seo.ts";
import { siteHost } from "./site-path.ts";
import { secretValues } from "./server/secrets.ts";

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
  /**
   * A public site's domain, by site name (`www: "sanoma.example"`): the app serves the site at the
   * root of that host, as it does at `<name>.localhost`. One naming a site that is missing or not
   * public is warned about and not served.
   */
  domains?: Record<string, string>;
  /**
   * Machine routes, answered right after `/healthz` and ahead of the public sites and the login,
   * at any host name: a request whose path is exactly `path` is answered by `handle`, or with 405
   * when `method` is given and the request's is another. One route per path, never `/healthz`.
   * Nothing checks who is asking, so each checks its own token; never give one a page's path.
   */
  ingress?: readonly IngressRoute[];
  /**
   * Called right before each change a worker must run that the app makes: a run's start (drift,
   * apply and a held call are starts) and an approval's decision; never for a read
   * (`ClientOptions.onWrite`). `sanoma serve` starts its worker again with it once the worker
   * stopped itself. Must not throw.
   */
  onWrite?: () => void;
  /**
   * Runs the repo as a demo: every vendor on its fake, one per vendor for the instance
   * (`resolveConfig`'s `fakes: "instance"`), the demo login (anyone is one of the company's
   * people, `?as=<id>` choosing whom), the world and the moments of its scenarios seeded on start
   * and again every hour (`reseed`, on the timer `sanoma.demo.reset`), a banner saying who you
   * are and that nothing is saved, and no chat agent and no Go live. The worker that runs its
   * runs must share the instance's fakes: start it in this process with the same `resolved`.
   */
  demo?: boolean;
  /**
   * The config as the caller resolved it (`resolveConfig(config, options)`), shared with a worker
   * in this process, as a demo's must be; the caller closes its `dataStore`. Default: resolved
   * here, with `fakes: "instance"` in a demo.
   */
  resolved?: ResolvedConfig;
}

/** One of `AppOptions.ingress`: a machine route, such as the wakeup's `/wake`. */
export interface IngressRoute {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** The whole path, from `/`, without a query: matched exactly, unless `prefix`. */
  path: string;
  /**
   * Also every path under `path` (`/wakeup` answers `/wakeup/instances/…`), for a route that
   * matches what follows itself. A route at the exact path comes first, then the longest prefix.
   */
  prefix?: boolean;
  handle(request: Request): Promise<Response>;
}

export interface App {
  /** Where the app listens, such as `http://127.0.0.1:3000`. */
  url: string;
  /** Each public site served, by name, at its own host on this machine: `http://<name>.localhost:<port>`. */
  sites: Record<string, string>;
  close(): Promise<void>;
}

/** Answers a request the login let through, a file's or the server entry's. */
interface Responder {
  respond(req: IncomingMessage, res: ServerResponse, request: Request, context: RequestContext): Promise<void>;
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
  const demo = options.demo === true;
  const resolved = options.resolved ?? resolveConfig(config, demo ? { fakes: "instance" } : {});
  if (demo && !resolved.instanceFakes) {
    throw new Error('A demo runs on its connectors\' fakes: resolve its config with `{ fakes: "instance" }`');
  }
  // A demo's client shares the resolution, so a store made here is closed here.
  const ownedStore = demo && !options.resolved ? resolved.dataStore : undefined;
  const given = options.login ?? (demo ? demoLogin(() => readPeople(resolved.root).people) : loopbackLogin());
  given.check(host, { demo });
  if (options.dev && !isLoopback(host)) {
    throw new Error(`The dev server listens on this machine only, not ${host}: serve a build there`);
  }
  // Read right after the policy made from them, so the Permissions page shows what decides.
  const policyFiles = resolved.root === undefined ? [] : readPolicyFiles(resolved.root);
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
  const warnings = description.sites.flatMap((site) => site.warnings.map((w) => `  ${warningLine(w)}`));
  if (warnings.length)
    console.warn(`sanoma app: warnings in the sites (\`sanoma check\` lists them):\n${warnings.join("\n")}`);
  const hosts = publicHosts(description, options.domains ?? {});
  const ingress = new Map<string, IngressRoute>();
  for (const route of options.ingress ?? []) {
    if (!/^\/[^?#]*$/.test(route.path) || route.path === "/healthz")
      throw new Error(
        `An ingress route's path starts with /, has no query and is not /healthz, unlike "${route.path}"`,
      );
    if (route.prefix && route.path.endsWith("/"))
      throw new Error(`A prefix ingress route's path does not end with /, unlike "${route.path}"`);
    if (ingress.has(route.path))
      throw new Error(`Two ingress routes have the path ${route.path}: give each path one route`);
    ingress.set(route.path, route);
  }
  // Longest first, so the first under which a path falls is the most specific.
  const prefixed = [...ingress.values()].filter((r) => r.prefix).toSorted((a, b) => b.path.length - a.path.length);
  const ingressAt = (path: string) => ingress.get(path) ?? prefixed.find((route) => path.startsWith(`${route.path}/`));
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
    const path = req.url?.split("?")[0];
    // A host's probe, before the login: it says the app answers, and nothing else.
    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return void res.end(req.method === "HEAD" ? undefined : "ok\n");
    }
    // A machine route, before the login too: it checks its own token.
    const route = path === undefined ? undefined : ingressAt(path);
    if (route?.method !== undefined && route.method !== req.method) {
      res.writeHead(405, {
        allow: route.method,
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      return void res.end(`${path} answers ${route.method} only\n`);
    }
    if (route) return sendNodeResponse(res, await route.handle(new NodeRequest({ req, res })));
    // A public site's host, ahead of the staff login, which it never reaches: the site's front door.
    const asked = hostName(req.headers.host ?? "");
    const entry = hosts.get(asked);
    if (entry !== undefined) {
      const site = sites.get(entry.name);
      if (!site) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        return void res.end(
          "This site is not served: its site.ts or its login has a problem, which the app's log names.\n",
        );
      }
      // The visitor's address, from the socket alone, for a login's rate limits: never a client's copy.
      req.headers[CLIENT_IP_HEADER] = req.socket.remoteAddress ?? "";
      const request = new NodeRequest({ req, res });
      // Its URLs are at its domain, when it has one; only there may a crawler index it.
      const origin = entry.domain ? `https://${entry.domain}` : requestOrigin(request);
      if (asked !== entry.domain) res.setHeader("x-robots-tag", "noindex");
      const answer = seoFile(request, entry, origin, published) ?? (await site.login.handle?.(request));
      if (answer) return sendNodeResponse(res, answer);
      return responder.respond(req, res, request, { app: site, site: entry.name, origin });
    }
    // A demo has no agent and never goes live: those pages and routes are not there.
    if (demo && path !== undefined && closedInDemo(path)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return void res.end("Not in a demo\n");
    }
    const request = new NodeRequest({ req, res });
    // Then the login sees every request (pages, server functions and static files alike): its
    // own routes, and any it will not let through.
    const answer = await login.handle?.(request);
    if (answer) return sendNodeResponse(res, answer);
    await responder.respond(req, res, request, { app, origin: requestOrigin(request) });
  }

  // The build first, importing nothing and connecting to nothing: a missing or half build is
  // refused before anything is opened. The dev server has nothing built to check.
  // What the sitemaps list of the content, drafts left out: `content/` as it is now on the dev
  // server, read at each request; else what the build wrote of it.
  let load: () => Promise<Responder>;
  let published: () => Published;
  if (options.dev) {
    const { repo, onFileChange } = options.dev;
    load = () => devResponder(repo, server, onFileChange);
    published = () => publishedOf(repo);
  } else {
    const distDir = resolve(options.distDir ?? defaultDistDir());
    const built = await readFile(join(distDir, PUBLISHED_FILE), "utf8").then(
      (text) => JSON.parse(text) as Published,
      // The package's own build has no content to list.
      (err: unknown) => {
        if (!isMissing(err)) throw err;
        return {};
      },
    );
    published = () => built;
    const files = await staticFiles(join(distDir, "client"));
    const serverEntry = join(distDir, "server", "server.js");
    await mustBeFile(serverEntry);
    load = async () => builtResponder(files, await loadServerEntry(serverEntry));
  }
  const [loaded, connected] = await Promise.allSettled([
    load(),
    // On the caller's resolution, as its worker; a demo's on its own too, the instance's fakes.
    SanomaClient.connect(config, { onWrite: options.onWrite, ...((demo || options.resolved) && { resolved }) }),
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
  const app: AppContext = {
    resolved,
    description,
    policyFiles,
    place: placeOf(resolved.databaseUrl),
    client,
    login,
    source: options.source,
    ...(demo && { demo: { ...config.demo } }),
  };
  // Each public site served, by name, with its own context, whose login is its front door: its
  // login half, if it has one, made once the app listens (`openLogins`). A public site whose
  // site.ts has a problem is not served, as its login could be one not read.
  const halves = new Map<SiteEntry, PromiseWithResolvers<LoginHalf>>();
  const sites = new Map<string, AppContext>();
  for (const site of description.sites) {
    if (!site.public) continue;
    const file = `${siteDir(site.name)}/site.ts`;
    if (site.problems.some((p) => p.file === file)) {
      console.warn(`sanoma app: ${file} has a problem: the site is served on no host until it is fixed`);
      continue;
    }
    const half = site.login === undefined ? undefined : Promise.withResolvers<LoginHalf>();
    if (half) halves.set(site, half);
    sites.set(site.name, { ...app, site: site.name, login: publicFront(site, half?.promise) });
  }

  let reset: { stop(): void } | undefined;
  try {
    // Seeded before it listens, so the first visitor finds the moments started.
    if (demo) reset = await demoReset(client, resolved);
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(options.port ?? 0, host, () => {
        server.off("error", fail);
        done();
      });
    });
  } catch (err) {
    reset?.stop();
    await responder.close();
    await closeQuietly(client);
    await ownedStore?.close();
    throw err;
  }

  const opened = await openLogins(resolved, client, halves);
  for (const { name } of halves.keys()) if (!opened.has(name)) sites.delete(name);

  const address = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(address)}:${address.port}`,
    sites: Object.fromEntries([...sites.keys()].map((name) => [name, `http://${localHost(name)}:${address.port}`])),
    close() {
      closing ??= (async () => {
        reset?.stop();
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
          await Promise.all(
            [...opened].map(([name, half]) =>
              half
                .close?.()
                .catch((err: unknown) =>
                  console.error(`sanoma app: closing ${siteDir(name)}'s login also failed:`, err),
                ),
            ),
          );
          await closeQuietly(client);
          await ownedStore?.close();
        }
      })();
      return closing;
    },
  };
}

/** What a demo does not serve: Go live (`/setup` and the GitHub App's routes under it) and the agent's routes. */
const DEMO_CLOSED = /^\/(setup|api\/chat|api\/sign-in)(\/|$)/i;

/**
 * Whether a demo leaves `path` unserved (`DEMO_CLOSED`), read as the router matches it: decoded,
 * in any case, repeated slashes as one.
 */
function closedInDemo(path: string): boolean {
  let read = path;
  try {
    read = decodeURIComponent(path);
  } catch {
    // Malformed: the router finds no route for it either.
  }
  return DEMO_CLOSED.test(read.replace(/\/{2,}/g, "/"));
}

/** How often a demo is seeded afresh (`sanoma.demo.reset`): every hour. */
const DEMO_RESET_MS = 60 * 60 * 1000;

/**
 * A demo's seed (`reseed`): once now, then every hour from now, `sanoma.demo.reset`: a timer in
 * this process, which holds the instance's fakes, not a schedule of the worker's (a demo's Runs
 * do not list it, and a new process starts its hour again). What a seed could not do is logged;
 * so is a later seed that fails, and the next hour tries again. `stop` ends the timer.
 */
async function demoReset(client: SanomaClient, resolved: ResolvedConfig): Promise<{ stop(): void }> {
  // Loaded only for a demo: it loads Cucumber.
  const { reseed } = await import("@sanoma-ai/workflows/scenarios");
  const seed = async () => {
    const { problems } = await reseed(client, resolved);
    for (const problem of problems) console.warn(`sanoma app: the demo's seed: ${problem}`);
  };
  await seed();
  const timer = setInterval(
    () => void seed().catch((err: unknown) => console.error("sanoma app: sanoma.demo.reset failed:", err)),
    DEMO_RESET_MS,
  ).unref();
  return { stop: () => clearInterval(timer) };
}

/** A public site's host on this machine. */
const localHost = (site: string) => `${siteHost(site)}.localhost`;

/**
 * A request's origin, https when a proxy that ends TLS says so (`x-forwarded-proto: https`), as
 * Start's `getRequestUrl({ xForwardedProto: true })` and the GitHub login's cookie read it: only
 * the absolute URLs a page writes take it.
 */
function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  if (request.headers.get("x-forwarded-proto") === "https") url.protocol = "https:";
  return url.origin;
}

/**
 * Each public site's hosts, to its entry: `<name>.localhost`, and the domain `domains` gives it
 * (then set on its entry). A domain naming a site that is missing or not public is warned about
 * and served nowhere; so is a host another site has first (one site per host).
 */
function publicHosts(description: ConfigDescription, domains: Record<string, string>): Map<string, SiteEntry> {
  const hosts = new Map<string, SiteEntry>();
  const claim = (host: string, site: SiteEntry) => {
    if (!hosts.has(host)) return void hosts.set(host, site);
    console.warn(`sanoma app: ${host} is another public site's host: ${siteDir(site.name)} is not served there`);
  };
  for (const site of description.sites) if (site.public) claim(localHost(site.name), site);
  for (const [name, domain] of Object.entries(domains)) {
    const site = description.sites.find((s) => s.name === name);
    if (!site?.public) {
      console.warn(`sanoma app: the domain ${domain} names ${siteDir(name)}, which is not a public site: not served`);
      continue;
    }
    const host = domain.toLowerCase();
    claim(host, site);
    if (hosts.get(host) === site) site.domain = host;
  }
  return hosts;
}

/**
 * Makes each public site's login half (`ConnectorSetup.login`), all at once, settling the promise
 * its front door waits on: the ones made, by site name. One that fails is logged, and its site is
 * then served on no host (503): the app starts, so the connector's page, or the environment
 * (`SANOMA_SECRETS_KEY`, which each login's key is derived from), can give what it lacks.
 */
async function openLogins(
  resolved: ResolvedConfig,
  client: SanomaClient,
  halves: ReadonlyMap<SiteEntry, PromiseWithResolvers<LoginHalf>>,
): Promise<Map<string, LoginHalf>> {
  const secrets = secretValues(client);
  const opened = new Map<string, LoginHalf>();
  await Promise.all(
    [...halves].map(async ([{ name, login, domain }, half]) => {
      const origins = [`http://${localHost(name)}:*`, ...(domain ? [`https://${domain}`] : [])];
      half.resolve(
        (async () =>
          resolved.logins.get(login!)!({
            databaseUrl: resolved.databaseUrl,
            key: loginKey(login!),
            secrets,
            origins,
          }))(),
      );
      try {
        opened.set(name, await half.promise);
      } catch (err) {
        console.error(
          `sanoma app: ${siteDir(name)}'s login (${login}) could not start, so the site is not served: ${errorMessage(err)}`,
        );
      }
    }),
  );
  return opened;
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
  async respond(req, res, request, context) {
    const file = staticFile(files, req);
    if (file) return sendFile(file, req, res);
    await sendNodeResponse(res, await entry.fetch(request, { context }));
  },
  close: async () => {},
});

/** Vite's dev server (`appDevServer`, loaded only here), then Start's entry as it imports it now. */
async function devResponder(repo: string, server: Server, onFileChange?: (file: string) => void): Promise<Responder> {
  const { appDevServer } = await import("./build.ts");
  const dev = await appDevServer(repo, server, onFileChange);
  return {
    respond: (req, res, request, context) =>
      new Promise((done, fail) => {
        // Vite answers what it serves itself without calling next.
        res.once("close", done);
        dev.middlewares(req, res, (err) => {
          if (err) return fail(err);
          dev
            .serverEntry()
            .then(async (entry) => sendNodeResponse(res, await entry.fetch(request, { context })))
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
