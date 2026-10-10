// DBOS's levels (winston's), most severe first. A message shows when its level is at or above the
// last `startWorker`'s `logLevel`, as DBOS's own do: `warn` by default.
const LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"];
let threshold = LEVELS.indexOf("warn");

/** Shows the messages at `level` and above from now on; an unknown level as `warn`. */
export function setLogLevel(level = "warn") {
  threshold = LEVELS.includes(level) ? LEVELS.indexOf(level) : LEVELS.indexOf("warn");
}

/** Tells the operator what the runtime did, such as loading credentials (never their values); shown at `info`. */
export const info = (message: string) => {
  if (threshold >= LEVELS.indexOf("info")) console.info(`sanoma: ${message}`);
};

/** Tells the operator something went wrong or was skipped, without failing anything; shown at `warn`. */
export const warn = (message: string) => {
  if (threshold >= LEVELS.indexOf("warn")) console.warn(`sanoma: ${message}`);
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
