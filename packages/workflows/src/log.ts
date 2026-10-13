import { AsyncLocalStorage } from "node:async_hooks";
import type { DLogger } from "@dbos-inc/dbos-sdk";

// DBOS's levels (winston's), most severe first. A message shows when its level is at or above the
// last `startWorker`'s `logLevel`, as DBOS's own do: `warn` by default.
const LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];
let threshold = LEVELS.indexOf("warn");

/** Shows the messages at `level` and above from now on; an unknown level as `warn`. */
export function setLogLevel(level = "warn") {
  threshold = LEVELS.includes(level) ? LEVELS.indexOf(level) : LEVELS.indexOf("warn");
}

const shows = (level: string) => threshold >= LEVELS.indexOf(level);

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
/** What sandbox runs failed with. */
const sandboxErrors = new WeakSet<object>();
/** DBOS's lines about a step's failed try, each with the error's stack. */
const STEP_FAILED = /^(Error in step being automatically retried|Non-retryable error in step)\./;

/**
 * Runs a workflow's body, as a sandbox run's when `sandbox`: `dbosLogger` then shows neither
 * DBOS's lines about its steps' failed tries nor the one about the error it fails with. A
 * scenario's fakes fail on purpose; the run's ledger and its status say what happened.
 */
export function quietIfSandbox<T>(sandbox: boolean, body: () => Promise<T>): Promise<T> {
  if (!sandbox) return body();
  return sandboxRun.run(true, body).catch((err: unknown) => {
    if (typeof err === "object" && err !== null) sandboxErrors.add(err);
    throw err;
  });
}

/**
 * DBOS's logger (`DBOS.setConfig`'s `logger`): its lines at the last `startWorker`'s `logLevel`,
 * printed as DBOS's own console logger prints them, except a sandbox run's (`quietIfSandbox`).
 * A live run's failed tries and failure show as they always did.
 */
export const dbosLogger: DLogger = {
  info: (entry) => void (shows("info") && console.log(entry)),
  debug: (entry) => void (shows("debug") && console.debug(entry)),
  warn(entry) {
    if (!shows("warn") || (sandboxRun.getStore() && STEP_FAILED.test(String(entry)))) return;
    console.warn(entry);
  },
  error(entry, metadata) {
    const error = metadata?.error;
    if (!shows("error") || (typeof error === "object" && error !== null && sandboxErrors.has(error))) return;
    if (entry instanceof Error) console.error(entry);
    else if (metadata?.stack) console.error(entry, "\n", metadata.stack);
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
