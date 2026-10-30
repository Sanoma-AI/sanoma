import { type Bridge, BridgeError, type ProviderRef } from "./bridge.ts";

/** The calls of a `Bridge` a driver makes. A `Bridge` is one, and so is `stateBridge` from `@sanoma-ai/bridge/fake`. */
export type ProviderClient = Pick<Bridge, "configure" | "import" | "read" | "plan" | "apply" | "close">;

interface Configured {
  /** The config the provider has, as far as this process knows. */
  config?: string;
  /** The configure steps for this release, one after another. */
  queue: Promise<void>;
  /**
   * The config the latest calls run under, when they may start, and those running. Later: one
   * provider instance per config, once the bridge can hold two, and no waiting.
   */
  turn?: { config: string; ready: Promise<unknown>; running: Set<Promise<unknown>> };
}

const configured = new WeakMap<ProviderClient, Map<string, Configured>>();

/** Forgets what `bridge` was configured with: its next call configures each provider afresh, as a new bridge needs. */
export function forgetConfigured(bridge: ProviderClient): void {
  // The config only: calls still waiting on a turn keep waiting, so none runs under another's.
  for (const state of configured.get(bridge)?.values() ?? []) state.config = undefined;
}

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
 * when the config changes (a new token, another owner): the bridge refuses a second config. The
 * configure steps for one bridge and release run one at a time, so concurrent calls, and drivers
 * sharing a bridge, configure once. Calls under one config run together; a call under another
 * waits until they are done, so closing the provider never cuts one off or answers it for the
 * other config.
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
  const state = stateOf(bridge, ref);
  let turn = state.turn;
  if (turn?.config !== configJson) {
    const before = turn;
    turn = state.turn = {
      config: configJson,
      ready: before ? before.ready.then(() => Promise.allSettled(before.running)) : Promise.resolve(),
      running: new Set(),
    };
  }
  const { ready, running } = turn;
  const mine = ready.then(() => configureAndCall(bridge, ref, configJson, call));
  running.add(mine);
  try {
    return await mine;
  } finally {
    running.delete(mine);
  }
}

/** Configures the provider unless it has `configJson`, and runs `call`: again once when the bridge had forgotten it. */
async function configureAndCall<T>(
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
