// The app on the Worker (`worker/main.ts` imports it on the first request): the app's handler
// (`appHandler`) over the snapshot and config the bundle was built with, a client of each
// request's own on the company's database, the staff's and the sites' sign-ins (Better Auth,
// composed as the `sanoma` bin composes them on Node) on that client's pool, and the Worker's
// assets for the client build and the prerendered pages. What needs the checkout is the worker's
// (`steps/`), not in the bundle.
// First: the runtime's registrations (the root and its snapshot, Cedar, DBOS's cron parser), made
// before any company file evaluates, through the routes too.
import { root, snapshot } from "virtual:sanoma/app-runtime";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  checkPreparedOnly,
  errorMessage,
  GITHUB_APP,
  resolveConfig,
  SanomaClient,
  type SocialClients,
} from "@sanoma-ai/workflows";
import { domainsOf } from "@sanoma-ai/workflows/shared";
import { betterAuthStaffLogin } from "@sanoma-ai/connector-better-auth";
import start from "@tanstack/react-start/server-entry";
import { config } from "virtual:sanoma/app-bundle";
import {
  type AppBundleContext,
  type AppBundleEnv,
  type AppHost,
  PRERENDERED,
  prerenderedAsset,
} from "../app-bundle.ts";
import type { AdmittingLogin } from "../context.ts";
import { type AppHandler, appHandler } from "../handler.ts";
import { admitting } from "../login/admission.ts";
import { publicFront, servedOnceMade, siteLogin } from "../login/public.ts";
import { staffLogin } from "../login/staff.ts";
import { plain } from "../server/webhooks.ts";
import { servedOnWorker } from "../snapshot.ts";

// The runtime, bundled (its registrations made by `virtual:sanoma/app-runtime`), on a database the
// worker prepares, never this Worker.
checkPreparedOnly("the company's worker, at its start,");

/** What each request's client is made from: its own connection (a Worker's sockets are its request's), on its first call. */
const requests = new AsyncLocalStorage<() => Promise<SanomaClient>>();

/** A path into the request's client: each property another path, a call awaiting the client and calling its namesake. Not a thenable. */
const member = (path: string[]): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => (typeof key === "string" && key !== "then" ? member([...path, key]) : undefined),
    apply: async (_target, _this, args: unknown[]) => {
      const connect = requests.getStore();
      if (!connect) throw new Error("the app's client was called outside a request");
      let owner = (await connect()) as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
      return (owner[path.at(-1)!] as (...args: unknown[]) => unknown).apply(owner, args);
    },
  });

/** The company's GitHub App's OAuth client from the Worker's secrets, both or neither (one alone is warned about and no GitHub). */
function socialOf(env: AppBundleEnv): SocialClients | undefined {
  const { [GITHUB_APP.client_id]: clientId, [GITHUB_APP.client_secret]: clientSecret } = env;
  if (clientId && clientSecret) return { github: { clientId, clientSecret } };
  if (clientId || clientSecret) {
    console.warn(
      `sanoma: GitHub sign-in needs both ${GITHUB_APP.client_id} and ${GITHUB_APP.client_secret}: it is off`,
    );
  }
  return undefined;
}

/** The handler, made on the first request from the Worker's bindings, which do not change in an isolate. */
let made: Promise<AppHandler> | undefined;

/**
 * The app's handler: the staff login (Better Auth's, admitting the snapshot's people) and each
 * served site with its login half, both on the request's client. A site whose login fails to be
 * made (its key, its config) is logged and served on no host (503), as on Node; so are the app's
 * own pages when the staff sign-in fails to start.
 */
async function handlerOf(env: AppBundleEnv): Promise<AppHandler> {
  const databaseUrl = env.DATABASE?.connectionString;
  if (!databaseUrl) throw new Error("the Worker has no DATABASE binding with a connection string");
  const resolved = resolveConfig({ ...config, root, databaseUrl });
  // Each call made on the request's own client (`requests`), `tokens.resolve` and the logins' pool too.
  const client = member([]) as SanomaClient;
  const social = socialOf(env);
  const staff = staffLogin(betterAuthStaffLogin, social);
  const domains = env.SANOMA_DOMAINS ? domainsOf(env.SANOMA_DOMAINS) : {};
  // Each site the Worker serves, with its login half when it has one; another public site answers 503 on its hosts here.
  const sites = new Map<string, AdmittingLogin>();
  const halves: Promise<unknown>[] = [];
  for (const site of snapshot.description.sites) {
    if (!servedOnWorker(site)) continue;
    const domain = domains[site.name];
    const half =
      site.login === undefined
        ? undefined
        : siteLogin(resolved, client, site, domain ? [`https://${domain}`] : [], social);
    sites.set(
      site.name,
      publicFront(site, half, (token) => client.tokens.resolve(token)),
    );
    if (half) halves.push(servedOnceMade(sites, site, half, "sanoma"));
  }
  const app = appHandler(
    {
      resolved,
      snapshot: () => snapshot,
      client,
      login: admitting(staff, () => snapshot.people),
      sites,
      domains,
      entry: start,
      files: (request, site) => assetFor(request, site, env),
    },
    snapshot,
  );
  // The staff sign-in that cannot start (its key, SANOMA_SIGNING_KEY, unset) is logged, and the
  // app's own pages answer 503 while the sites are served, as a site whose half failed.
  const opened = staff.open?.(app.context).catch((err: unknown) => {
    console.error(`sanoma: the staff sign-in could not start, so the app's pages are not served: ${errorMessage(err)}`);
  });
  await Promise.all([opened, ...halves]);
  return app;
}

/**
 * A GET's or HEAD's file from the Worker's assets: one of the client build at a path with an
 * extension (a site's public files too; `/assets/*` is the assets' own, never the Worker's), else
 * on a public site's domain the page prerendered there, unless a query, which the page may read,
 * asks otherwise. Undefined when the assets have none.
 */
async function assetFor(request: Request, site: string | undefined, env: AppBundleEnv) {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const url = new URL(request.url);
  const path = assetPath(url, site);
  if (path === undefined) return undefined;
  const asset = await env.ASSETS.fetch(new Request(new URL(path, url), request));
  if (asset.ok) return asset;
  await asset.body?.cancel();
  return undefined;
}

/** Where in the assets the request's file is: none for the prerendered pages' own path, nor a page with a query. */
function assetPath(url: URL, site: string | undefined): string | undefined {
  if (/\.[^/]+$/.test(url.pathname)) return url.pathname.startsWith(`${PRERENDERED}/`) ? undefined : url.pathname;
  if (site === undefined || url.search) return undefined;
  return prerenderedAsset(url.hostname, url.pathname);
}

/** `response`, its body passed on as it streams, then `close` called once it is sent (or failed). */
function closingAfter(response: Response, close: () => Promise<void>, ctx: AppBundleContext): Response {
  if (!response.body) {
    ctx.waitUntil(close());
    return response;
  }
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(response.body.pipeTo(writable).finally(close));
  return new Response(readable, response);
}

/** Answers one request: the app's handler, with a client of the request's own; a run queued has the host start the worker. */
export async function serve(
  request: Request,
  env: AppBundleEnv,
  ctx: AppBundleContext,
  host: AppHost | undefined,
): Promise<Response> {
  const app = await (made ??= handlerOf(env).catch((err: unknown) => {
    made = undefined;
    throw err;
  }));
  const { hostname } = new URL(request.url);
  if (env.SANOMA_HOSTNAME && hostname !== env.SANOMA_HOSTNAME.toLowerCase() && !app.hosts.has(hostname)) {
    return plain(404, "Not found\n");
  }
  let client: Promise<SanomaClient> | undefined;
  // Once per request, however many writes it makes: the worker starts once.
  let starting: Promise<unknown> | undefined;
  const connect = () =>
    (client ??= SanomaClient.connect(
      { ...config, root, databaseUrl: app.context.resolved.databaseUrl },
      {
        // A run waits for a worker of this bundle's code, which may not be live yet.
        appVersion: snapshot.version,
        onWrite: () => {
          if (starting || !host) return;
          starting = host.startNow().catch((err: unknown) => console.error("sanoma: starting the worker failed:", err));
          ctx.waitUntil(starting);
        },
      },
    ));
  const close = async () => {
    if (!client) return;
    // A client that never connected (its connect rejected) has nothing to close, and says so here too.
    await client
      .then((connected) => connected.close())
      .catch((err: unknown) => console.error("sanoma: closing the request's client failed:", err));
  };
  try {
    return closingAfter(await requests.run(connect, () => app.fetch(request)), close, ctx);
  } catch (err) {
    ctx.waitUntil(close());
    throw err;
  }
}
