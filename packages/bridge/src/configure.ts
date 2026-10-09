import { type Bridge, BridgeError, type ProviderRef } from "./bridge.ts";

/** The calls of a `Bridge` a driver makes. A `Bridge` is one, and so is `stateBridge` from `@sanoma/bridge/fake`. */
export type ProviderClient = Pick<Bridge, "configure" | "import" | "read" | "close">;

interface Configured {
  /** The config the provider has, as far as this process knows. */
  config?: string;
  /** The configure steps for this release, one after another. */
  queue: Promise<void>;
}

const configured = new WeakMap<ProviderClient, Map<string, Configured>>();

function stateOf(bridge: ProviderClient, ref: ProviderRef): Configured {
  let releases = configured.get(bridge);
  if (!releases) configured.set(bridge, (releases = new Map()));
  const name = `${ref.source} ${ref.version}`;
  let state = releases.get(name);
  if (!state) releases.set(name, (state = { queue: Promise.resolve() }));
  return state;
}

/** Configures the provider with `configJson` unless it has it; another config is closed first, as the bridge requires. */
function configure(bridge: ProviderClient, ref: ProviderRef, configJson: string): Promise<void> {
  const state = stateOf(bridge, ref);
  const step = state.queue.then(async () => {
    if (state.config === configJson) return;
    if (state.config !== undefined) {
      state.config = undefined;
      await bridge.close(ref);
    }
    await bridge.configure(ref, configJson);
    state.config = configJson;
  });
  state.queue = step.catch(() => {});
  return step;
}

const notConfigured = (e: BridgeError) => e.code === "failed_precondition" && / is not configured/.test(e.message);

/**
 * Makes sure the provider `ref` names is configured on `bridge` with `configJson`, then runs
 * `call`, if given. The provider is configured on first use, and closed and configured again
 * when the config changes (a new token): the bridge refuses a second config. The configure
 * steps for one bridge and release run one at a time, so concurrent calls, and drivers sharing
 * a bridge, configure once.
 *
 * When `call` (or the configure) finds the provider gone (`unavailable`: it exited, or the
 * bridge did), the error is rethrown and the next call configures it again. When the bridge
 * says the provider is not configured (a restarted bridge, or another client closed it), it is
 * configured again and `call` tried once more.
 */
export async function ensureConfigured(bridge: ProviderClient, ref: ProviderRef, configJson: string): Promise<void>;
export async function ensureConfigured<T>(
  bridge: ProviderClient,
  ref: ProviderRef,
  configJson: string,
  call: () => Promise<T>,
): Promise<T>;
export async function ensureConfigured<T>(
  bridge: ProviderClient,
  ref: ProviderRef,
  configJson: string,
  call?: () => Promise<T>,
): Promise<T | void> {
  const run = async () => {
    await configure(bridge, ref, configJson);
    return call?.();
  };
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    if (error.code !== "unavailable" && !notConfigured(error)) throw error;
    stateOf(bridge, ref).config = undefined;
    if (error.code === "unavailable") throw error;
    return run();
  }
}
