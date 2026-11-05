import type { LoginIdentity, Principal, ResolvedConfig, SanomaClient, Source } from "@sanoma-ai/workflows";
import type { Place } from "./api.ts";
import type { AppSnapshot } from "./snapshot.ts";

export type { LoginIdentity } from "@sanoma-ai/workflows";

/**
 * Says who is making a request, or undefined when nobody is named. The app refuses a change
 * (starting a run, deciding an approval) without one.
 */
export type ResolveActor = (request: Request) => LoginIdentity | undefined | Promise<LoginIdentity | undefined>;

/**
 * Who may use the app and how they sign in. The Node adapter (`startApp`) calls `check` with the
 * host it is to listen on before anything else, `open` once it listens; the app gives every request to `handle` first,
 * and asks `resolveActor` who is making a change; `close` when it stops. The default,
 * `loopbackLogin()`, takes the name the page sends and refuses any host but this machine;
 * `staffLogin` signs people in with a login half (Better Auth's) on a host.
 */
export interface LoginProvider {
  /** Names the provider; its routes, if any, are under `/auth/<name>/`. */
  name: string;
  /** Throws when the app may not listen on `listenHost` with this provider. */
  check(listenHost: string): void;
  resolveActor: ResolveActor;
  /**
   * Sees every request first: answers the ones it owns (its `/auth/<name>/` routes, and a request
   * nobody has signed in for), and returns undefined for the rest, which the app answers.
   */
  handle?(request: Request): Response | undefined | Promise<Response | undefined>;
  /** The path the page POSTs to to sign out, which `handle` serves; none, no Sign out. */
  signOut?: string;
  /** Called once the app listens, with what it serves: a login that needs the client or the files starts here. */
  open?(app: AppContext): Promise<void>;
  /** Called when the app stops. */
  close?(): Promise<void>;
  /**
   * An invite for the declared person `email` names, minted for `by` (a declared person's id, or
   * the runtime's agent `login` for a sealed request): its link, on `origin`. Only a login that has
   * invites; it records the mint.
   */
  invite?(email: string, request: { origin: string; by: string }): Promise<{ url: string; expiresAt: Date }>;
}

/** A login as the app uses it (`admitting`): `resolveActor` names the declared principal asking, or nobody. */
export interface AdmittingLogin extends Omit<LoginProvider, "resolveActor"> {
  resolveActor(request: Request): Promise<Principal | undefined>;
}

/**
 * What the app hands each request (`appHandler`): the config resolved, the company as the build
 * or the Node adapter read it (`snapshot`, taken once per request), and the request's client and
 * login. Nothing in it reads a file.
 */
export interface AppContext {
  resolved: ResolvedConfig;
  /** The company as its files were read (`AppSnapshot`): what the pages read of it, never the files themselves. */
  snapshot: AppSnapshot;
  /** Where this instance is, from `resolved.databaseUrl` (`placeOf`): what the bar's badge says. */
  place: Place;
  client: SanomaClient;
  /** The staff login (`AppOptions.login`, or `loopbackLogin()`), admitting only a declared person (`admitting`). */
  login: AdmittingLogin;
  /**
   * The company's checkout, on a host that has one (the Node adapter's): what the actions that
   * write the repository or run a child process work in (`server/local/`). None on the Worker,
   * where those answer that they are not available on this host.
   */
  local?: LocalHost;
  /**
   * The built kit's stylesheet's path (`/assets/style-<hash>.css`), which a login's own pages link
   * to look like the app; none on the dev server, which builds nothing.
   */
  stylesheet?: string;
  /**
   * On a public site's own host, the site: its copy of the context, whose `login` is the site's
   * front door (`publicFront`), so only `callFn` and `getActor` answer there, as a visitor.
   */
  site?: string;
}

/** What the Node adapter gives the actions that need the checkout (`AppContext.local`). */
export interface LocalHost {
  /** The company's repository, which Adopt commits a data file's change to; without one, it only writes the file. */
  source?: Source;
}

/**
 * What the app hands Start with each request: the app, and the public site whose host the request came
 * to, when it came to one; the router then mounts that site's routes at `/`. `origin` is what a
 * page's absolute URLs start with (`siteOrigin()`): the site's domain when it has one, else the
 * request's own origin.
 */
export interface RequestContext {
  app: AppContext;
  site?: string;
  origin: string;
}

/** Start's server entry, which the app hands each request with the context: the build's `server.js`, the dev server's, or the Worker bundle's own. */
export interface ServerEntry {
  fetch(request: Request, opts?: { context?: RequestContext }): Response | Promise<Response>;
}
