import type { ConfigDescription, Principal, ResolvedConfig, SanomaClient } from "@sanoma/workflows";

/**
 * Says who is making a request, or undefined when nobody is named. The app refuses a change
 * (starting a run, deciding an approval) without one. The default reads the `x-sanoma-actor`
 * header; a hosted deployment replaces it with its own login.
 */
export type ResolveActor = (request: Request) => Principal | undefined | Promise<Principal | undefined>;

/** What `startApp` hands every request: built once at boot, shared by all requests. */
export interface AppContext {
  resolved: ResolvedConfig;
  description: ConfigDescription;
  client: SanomaClient;
  resolveActor: ResolveActor;
  /**
   * True when `resolveActor` is the default, which reads the `x-sanoma-actor` header the page
   * sends. A flag, not a comparison of functions: the server bundle has its own copy of it.
   */
  actorFromHeader: boolean;
}
