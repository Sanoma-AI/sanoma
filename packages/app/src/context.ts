import type { Principal, ResolvedConfig, SanomaClient, Source } from "@sanoma-ai/workflows";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import type { Place } from "./api.ts";

/**
 * What a login vouches for about who is asking: a name they gave (`id`, the loopback's), a
 * verified email, a GitHub login. The app admits the declared person they match (`personOf`).
 */
export interface LoginIdentity {
  id?: string;
  email?: string;
  github?: string;
}

/**
 * Says who is making a request, or undefined when nobody is named. The app refuses a change
 * (starting a run, deciding an approval) without one.
 */
export type ResolveActor = (request: Request) => LoginIdentity | undefined | Promise<LoginIdentity | undefined>;

/**
 * Who may use the app and how they sign in. `startApp` calls `check` with the host it is to
 * listen on before anything else, gives every request to `handle` first, and asks
 * `resolveActor` who is making a change. The default, `loopbackLogin()`, takes the name the page
 * sends and refuses any host but this machine; `githubLogin` signs people in with GitHub.
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
}

/** A login as the app uses it (`admitting`): `resolveActor` names the declared principal asking, or nobody. */
export interface AdmittingLogin extends Omit<LoginProvider, "resolveActor"> {
  resolveActor(request: Request): Promise<Principal | undefined>;
}

/** What `startApp` hands every request: built once at boot, shared by all requests. */
export interface AppContext {
  resolved: ResolvedConfig;
  /**
   * `describeConfig(config)`, made once: what the page reads (`getConfig`), less the
   * workflows' sources (`withoutSources`), which `getSource` serves one at a time.
   */
  description: ConfigDescription;
  /** Where this instance is, from `resolved.databaseUrl` (`placeOf`): what the bar's badge says. */
  place: Place;
  client: SanomaClient;
  /** `AppOptions.login`, or `loopbackLogin()`, admitting only a declared person (`admitting`). */
  login: AdmittingLogin;
  /** The company's repository, which Adopt commits a data file's change to; without one, it only writes the file. */
  source?: Source;
  /**
   * On a public site's own host, the site: its copy of the context, whose `login` is the site's
   * front door (`publicFront`), so only `callFn` and `getActor` answer there, as a visitor.
   */
  site?: string;
}

/**
 * What `startApp` hands each request: the app, and the public site whose host the request came
 * to, when it came to one; the router then mounts that site's routes at `/`. `origin` is what a
 * page's absolute URLs start with (`siteOrigin()`): the site's domain when it has one, else the
 * request's own origin.
 */
export interface RequestContext {
  app: AppContext;
  site?: string;
  origin: string;
}

/** Start's server entry, which `startApp` hands each request with the context: the build's `server.js`, or the dev server's. */
export interface ServerEntry {
  fetch(request: Request, opts?: { context?: RequestContext }): Response | Promise<Response>;
}
