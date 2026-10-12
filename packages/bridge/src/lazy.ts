import { DriverError, errorMessage } from "@sanoma/workflows";
import { type Bridge, BridgeError } from "./bridge.ts";
import { startBridge, type StartBridgeOptions } from "./client.ts";
import { forgetConfigured, type ProviderClient } from "./configure.ts";

/** A `ProviderClient` over a bridge started on its first call, with `stop()` for the bridge it started, if any. */
export interface LazyBridge extends ProviderClient {
  stop(): Promise<void>;
}

export interface LazyBridgeOptions extends StartBridgeOptions {
  /** What starts the bridge. Default `startBridge`; a test passes its own, so none needs the binary. */
  start?: typeof startBridge;
}

/**
 * A provider bridge started on its first call, so loading a config (the app, the tests) never
 * spawns it. A start that fails is tried again on the next call; one that cannot start (no
 * binary) fails the call as a `DriverError` that is not retried, and a `BridgeError` is thrown
 * as it is. When a configure, import or read finds the bridge `unavailable` (it exited, or its
 * socket did), the bridge is stopped and forgotten, with what `ensureConfigured` configured on
 * it, and the next call starts another. The bridge exits with this process, or on `stop()`,
 * after which the next call starts another.
 */
export function lazyBridge(options: LazyBridgeOptions = {}): LazyBridge {
  const { start = startBridge, ...startOptions } = options;
  let started: Promise<Bridge> | undefined;
  const bridge = () =>
    (started ??= start(startOptions).catch((err: unknown) => {
      started = undefined;
      throw err instanceof BridgeError ? err : new DriverError(errorMessage(err), { retryable: false });
    }));
  /** Lets go of the bridge `current` started, if it is still the one: the next call starts another, unconfigured. */
  const drop = (current: Promise<Bridge> | undefined) => {
    if (current !== started) return;
    started = undefined;
    forgetConfigured(lazy);
  };
  /** `call` on the bridge, started if need be; one that finds the bridge gone is dropped and stopped, its stop error ignored. */
  async function on<T>(call: (b: Bridge) => Promise<T>): Promise<T> {
    const current = bridge();
    try {
      return await call(await current);
    } catch (err) {
      if (err instanceof BridgeError && err.code === "unavailable") {
        drop(current);
        void current.then((b) => b.stop()).catch(() => {});
      }
      throw err;
    }
  }
  const lazy: LazyBridge = {
    configure: (...args) => on((b) => b.configure(...args)),
    import: (...args) => on((b) => b.import(...args)),
    read: (...args) => on((b) => b.read(...args)),
    close: async (...args) => (started ? (await started).close(...args) : undefined),
    stop: async () => {
      const current = started;
      drop(current);
      // A start still failing has nothing to stop.
      await (await current?.catch(() => undefined))?.stop();
    },
  };
  return lazy;
}

let shared: LazyBridge | undefined;

/** The process's one lazy bridge, made on the first call: what a driver reads through when it is given no `bridge`. */
export function defaultBridge(): LazyBridge {
  return (shared ??= lazyBridge());
}
