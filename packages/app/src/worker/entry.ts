// The public sites on the Cloudflare host's Worker (`buildWorker` in `build.ts`): the main module
// of the sites bundle, which the Cloudflare connector uploads beside its own Durable Object and
// router (`worker/sites.js` in `@sanoma-ai/connector-cloudflare`). A request to a public site's
// domain that the bundle serves is answered here: a prerendered page from the Worker's assets,
// `robots.txt` and `sitemap.xml`, else Start rendering the page and answering `callFn` and
// `getActor`, as the visitor, over the company's database; a run start enqueues the run and has
// the object start the container, which runs it. Everything else (the app's domain, `/wake`,
// webhooks, a site with a login) goes to the object and the container, as before.
import { checkPreparedOnly, resolveConfig, SanomaClient, useCedarWasm, useRootSnapshot } from "@sanoma-ai/workflows";
import { domainsOf } from "@sanoma-ai/workflows/shared";
import start from "@tanstack/react-start/server-entry";
import { cedar, config, description, published, root, served as servedSites, snapshot } from "virtual:sanoma/worker";
import type { AppContext } from "../context.ts";
import { publicFront } from "../login/public.ts";
import { placeOf } from "../loopback.ts";
import { seoFile } from "../seo.ts";
import { PRERENDERED } from "./prerendered.ts";

/** The paths a site's domain still sends to the container: the object's own, and the app's machine and login routes. */
const CONTAINER_PATHS = /^\/(__sanoma|api|auth|webhooks|setup|wake|healthz)(\/|$)/;

/** What the Worker's bindings give the bundle: the container's environment, and the Worker's assets. */
export interface WorkerEnv {
  /** `<site>=<hostname>,…`: the public sites' domains, as the container is given them. */
  SANOMA_DOMAINS?: string;
  /** The company's database, the container's. */
  SANOMA_DATABASE_URL?: string;
  /** The Worker's static assets: the client build and the prerendered pages. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Set by the build's own preview only: `/__sanoma/sites/<site>/…` renders that site's page, for its prerender. */
  SANOMA_PRERENDER?: string;
}

/** What the Worker's request gives a handler to keep working after the response. */
export interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** What the connector's router gives the bundle: the container, through its object. */
export interface WorkerHost {
  /** Starts the container now, without waiting for it: a run was queued for it. */
  startNow(): Promise<unknown>;
}

// The runtime, bundled: the root's people, policies and app name as data, Cedar's web build, and
// a database the container prepares, never this Worker.
useRootSnapshot(root, snapshot);
useCedarWasm(cedar);
checkPreparedOnly("the company's container, at its start,");

/** The sites this bundle serves, by name. */
const served = new Map(servedSites.map((site) => [site.name, site]));

/** The site served at each hostname, by `SANOMA_DOMAINS` as last parsed: the same text on every request of an isolate. */
let hosts: { text: string; sites: Map<string, string> } | undefined;

/** The site the request is for: one this bundle serves, on its domain. */
function siteAt(url: URL, env: WorkerEnv): { name: string; domain: string } | undefined {
  const text = env.SANOMA_DOMAINS;
  if (!text) return undefined;
  if (hosts?.text !== text) {
    const pairs = Object.entries(domainsOf(text)).filter(([name]) => served.has(name));
    hosts = { text, sites: new Map(pairs.map(([name, domain]) => [domain, name])) };
  }
  const name = hosts.sites.get(url.hostname);
  return name === undefined ? undefined : { name, domain: url.hostname };
}

/** The prerendered page for `pathname`, among the Worker's assets: undefined for a path with a trailing slash, which the router redirects. */
const prerenderedPath = (site: string, pathname: string) =>
  pathname === "/"
    ? `${PRERENDERED}/${site}/index.html`
    : pathname.endsWith("/")
      ? undefined
      : `${PRERENDERED}/${site}${pathname}/index.html`;

/** The config resolved over the bundled root, once per isolate: what `callApi` reads of it opens nothing. */
let resolved: ReturnType<typeof resolveConfig> | undefined;

/**
 * A client that connects on its first call, so a page that calls no `api` opens no connection: each
 * property is a function that awaits the client and calls its namesake (`tokens.resolve` too). Not
 * a thenable: `then` is undefined.
 */
function lazily(connect: () => Promise<SanomaClient>): { client: SanomaClient; close(): Promise<void> } {
  let made: Promise<SanomaClient> | undefined;
  const member = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (typeof key === "string" && key !== "then" ? member([...path, key]) : undefined),
      apply: async (_target, _this, args: unknown[]) => {
        let owner: Record<string, unknown> = (await (made ??= connect())) as never;
        for (const key of path.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
        return (owner[path.at(-1)!] as (...args: unknown[]) => unknown).apply(owner, args);
      },
    });
  return { client: member([]) as SanomaClient, close: async () => void (made && (await (await made).close())) };
}

/**
 * The app's context for one request to `site` on the Worker: the config resolved over the bundled
 * root, a client of its own on the company's database, made on its first call (a Worker's
 * connections are its request's), and the site's front door, which takes a visitor as `anonymous`
 * or by an api token. A run start (`onWrite`) has the container started.
 */
function siteApp(site: string, env: WorkerEnv, ctx: WorkerContext, host: WorkerHost) {
  const databaseUrl = env.SANOMA_DATABASE_URL;
  const bundled = { ...config, root, ...(databaseUrl && { databaseUrl }) };
  resolved ??= resolveConfig(bundled);
  const { client, close } = lazily(async () => {
    if (!databaseUrl) throw new Error("the Worker has no SANOMA_DATABASE_URL among its secrets");
    // Once per request, however many writes it makes: the container starts once.
    let starting: Promise<unknown> | undefined;
    return SanomaClient.connect(bundled, {
      onWrite: () => {
        if (starting) return;
        starting = host
          .startNow()
          .catch((err: unknown) => console.error("sanoma: starting the container failed:", err));
        ctx.waitUntil(starting);
      },
    });
  });
  const app: AppContext = {
    resolved,
    description,
    place: placeOf(resolved.databaseUrl),
    client,
    site,
    login: publicFront(served.get(site)!, undefined, (token) => client.tokens.resolve(token)),
  };
  return { app, close };
}

/** `response`, its body passed on as it streams, then `close` called once it is sent (or failed). */
function closingAfter(response: Response, close: () => Promise<void>, ctx: WorkerContext): Response {
  if (!response.body) {
    ctx.waitUntil(close());
    return response;
  }
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(response.body.pipeTo(writable).finally(close));
  return new Response(readable, response);
}

/** A page of `site`, rendered here (`request`'s path on the site's host), or a call its pages make. */
async function render(
  request: Request,
  env: WorkerEnv,
  ctx: WorkerContext,
  host: WorkerHost,
  site: { name: string; domain: string },
) {
  const entry = served.get(site.name)!;
  const origin = `https://${site.domain}`;
  const seo = seoFile(request, entry, origin, () => published);
  if (seo) return seo;
  const { app, close } = siteApp(site.name, env, ctx, host);
  const closing = () =>
    close().catch((err: unknown) => console.error("sanoma: closing the request's client failed:", err));
  try {
    const answer =
      (await app.login.handle?.(request)) ??
      (await start.fetch(request, { context: { app, site: site.name, origin } }));
    return closingAfter(answer, closing, ctx);
  } catch (err) {
    ctx.waitUntil(closing());
    throw err;
  }
}

/** For the build's prerender: `/__sanoma/sites/<site>/<path>` is `<path>` on that site's host. */
function prerenderRequest(request: Request, env: WorkerEnv) {
  if (env.SANOMA_PRERENDER !== "1") return undefined;
  const url = new URL(request.url);
  const [, name, ...rest] = url.pathname.slice(PRERENDERED.length).split("/");
  const entry = name === undefined ? undefined : served.get(name);
  if (!url.pathname.startsWith(`${PRERENDERED}/`) || !entry) return undefined;
  // Each site the bundle serves has a domain (`workerSites`).
  const domain = entry.domain!;
  const page = new URL(`/${rest.join("/")}${url.search}`, `https://${domain}`);
  return { request: new Request(page, request), site: { name: entry.name, domain } };
}

/** The asset for a GET of `url` on `site`: a file of the client build at a path with an extension (a site's public files too; `/assets/*` never gets here), else the page prerendered for it unless a query, which the page may read, asks otherwise. */
function assetPath({ pathname, search }: URL, site: string): string | undefined {
  if (/\.[^/]+$/.test(pathname)) return pathname.startsWith(`${PRERENDERED}/`) ? undefined : pathname;
  return search ? undefined : prerenderedPath(site, pathname);
}

/** The sites bundle's contract with the connector's router: what it serves, and how. */
export default {
  /** Whether this request is the bundle's: a site it serves, on its domain, but for the paths the container keeps. */
  serves(request: Request, env: WorkerEnv): boolean {
    const url = new URL(request.url);
    return siteAt(url, env) !== undefined && !CONTAINER_PATHS.test(url.pathname);
  },

  async fetch(request: Request, env: WorkerEnv, ctx: WorkerContext, host: WorkerHost): Promise<Response> {
    const prerender = prerenderRequest(request, env);
    if (prerender) return render(prerender.request, env, ctx, host, prerender.site);
    const url = new URL(request.url);
    const site = siteAt(url, env);
    if (!site) return new Response("Not found\n", { status: 404 });
    const file = request.method === "GET" || request.method === "HEAD" ? assetPath(url, site.name) : undefined;
    if (file && env.ASSETS) {
      const asset = await env.ASSETS.fetch(new Request(new URL(file, url), request));
      if (asset.ok) return asset;
      await asset.body?.cancel();
    }
    return render(request, env, ctx, host, site);
  },
};
