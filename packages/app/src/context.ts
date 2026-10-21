import type { Principal, ResolvedConfig, SanomaClient, Source } from "@sanoma-ai/workflows";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";

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
  /**
   * The root's `policies/**\/*.cedar` (`readPolicyFiles`), read as it starts, beside the policy
   * `resolveConfig` made from them: the source the Permissions page shows with its grid; none
   * when not given.
   */
  policyFiles?: { file: string; text: string }[];
  client: SanomaClient;
  /** `AppOptions.login`, or `loopbackLogin()`, admitting only a declared person (`admitting`). */
  login: AdmittingLogin;
  /** The company's repository, which Adopt commits a data file's change to; without one, it only writes the file. */
  source?: Source;
}

/** Start's server entry, which `startApp` hands each request with the context: the build's `server.js`, or the dev server's. */
export interface ServerEntry {
  fetch(request: Request, opts?: { context?: { app: AppContext } }): Response | Promise<Response>;
}
