import type { Principal, ResolvedConfig, SanomaClient, Source } from "@sanoma-ai/workflows";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";

/**
 * Says who is making a request, or undefined when nobody is named. The app refuses a change
 * (starting a run, deciding an approval) without one. The default reads the `x-sanoma-actor`
 * header; a hosted deployment replaces it with its own login.
 */
export type ResolveActor = (request: Request) => Principal | undefined | Promise<Principal | undefined>;

/** What `startApp` hands every request: built once at boot, shared by all requests. */
export interface AppContext {
  resolved: ResolvedConfig;
  /**
   * `describeConfig(config)`, made once: what the page reads (`getConfig`), less the
   * workflows' sources (`withoutSources`), which `getSource` serves one at a time.
   */
  description: ConfigDescription;
  client: SanomaClient;
  /** The deployment's own; undefined for the default, the `x-sanoma-actor` header the page sends. */
  resolveActor?: ResolveActor;
  /** The company's repository, which Adopt commits a data file's change to; without one, it only writes the file. */
  source?: Source;
}
