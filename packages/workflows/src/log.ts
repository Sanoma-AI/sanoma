import { AsyncLocalStorage } from "node:async_hooks";
import type { DLogger } from "@dbos-inc/dbos-sdk";

// DBOS's levels (winston's), most severe first. A message shows when its level is at or above the
// last `startWorker`'s `logLevel`, as DBOS's own do: `warn` by default. One threshold for the
// process, as DBOS's own logger is one per process.
const LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];
const levelsUpTo = (level: string) => new Set(LEVELS.slice(0, LEVELS.indexOf(level) + 1));
let visible = levelsUpTo("warn");

/** Shows the messages at `level` and above from now on; an unknown level as `warn`. */
export function setLogLevel(level = "warn") {
  visible = levelsUpTo(LEVELS.includes(level) ? level : "warn");
}

const shows = (level: string) => visible.has(level);

/** Tells the operator what the runtime did, such as loading credentials (never their values); shown at `info`. */
export const info = (message: string) => {
  if (shows("info")) console.info(`sanoma: ${message}`);
};

/** Tells the operator something went wrong or was skipped, without failing anything; shown at `warn`. */
export const warn = (message: string) => {
  if (shows("warn")) console.warn(`sanoma: ${message}`);
};

/** Set while a sandbox run's body runs. */
const sandboxRun = new AsyncLocalStorage<true>();
/** What sandbox runs failed with: each a copy made for its run (`quietIfSandbox`). */
const sandboxErrors = new WeakSet<object>();

/**
 * Runs a workflow's body, as a sandbox run's when `sandbox`: `dbosLogger` then shows none of DBOS's
 * warnings from inside it (its steps' failed tries among them), nor the error it fails with. A
 * scenario's fakes fail on purpose; the run's ledger and its status say what happened. The run
 * fails with a copy of its error (same prototype and properties), made for it, so the same error
 * object thrown by a live run is still shown.
 */
export function quietIfSandbox<T>(sandbox: boolean, body: () => Promise<T>): Promise<T> {
  if (!sandbox) return body();
  return sandboxRun.run(true, body).catch((err: unknown) => {
    if (typeof err !== "object" || err === null) throw err;
    const copy = Object.create(Object.getPrototypeOf(err), Object.getOwnPropertyDescriptors(err)) as object;
    // V8's `stack` accessor reads the original's internal slot, which the copy lacks.
    if ("stack" in err) Object.defineProperty(copy, "stack", { value: err.stack, writable: true, configurable: true });
    sandboxErrors.add(copy);
    throw copy;
  });
}

/**
 * DBOS's logger (`DBOS.setConfig`'s `logger`): its lines at the last `startWorker`'s `logLevel`,
 * printed as DBOS's own console logger (`DBOSConsoleLogger`) prints them, except a sandbox run's
 * (`quietIfSandbox`). A live run's failed tries and failure show as they always did. Installed
 * only while DBOS exports no logs over OTLP: a custom logger replaces that transport.
 */
export const dbosLogger: DLogger = {
  info: (entry) => void (shows("info") && console.log(entry)),
  debug: (entry) => void (shows("debug") && console.debug(entry)),
  warn(entry) {
    if (shows("warn") && !sandboxRun.getStore()) console.warn(entry);
  },
  // DBOS's GlobalLogger passes a string, with the stack in `metadata.stack` and an error in `metadata.error`.
  error(entry, metadata) {
    const error = metadata?.error;
    if (!shows("error") || (typeof error === "object" && error !== null && sandboxErrors.has(error))) return;
    if (metadata?.stack) console.error(entry, "\n", metadata.stack);
    else console.error(entry);
  },
};

/** A value as JSON, or as a string when it isn't JSON, cut to `max` characters, for a message. */
export function shown(value: unknown, max = Number.POSITIVE_INFINITY): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
