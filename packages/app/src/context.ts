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
  /** True when the app listens on a loopback address, so requests must be addressed to one. */
  loopbackOnly: boolean;
}
