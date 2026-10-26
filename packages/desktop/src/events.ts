import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

/** Where the app answers once the launcher is ready, and each public site, by name. */
export interface Ready {
  url: string;
  sites: Record<string, string>;
}

/**
 * A line a launcher started with `SANOMA_EVENTS=1` prints on stdout for its parent (#286 L1):
 * `{"sanoma":1,"event":"ready","url":…,"sites":{…}}`, `{"sanoma":1,"event":"error","message":…}`,
 * and others this shell only logs (`database`).
 */
export type LauncherEvent =
  | ({ event: "ready" } & Ready)
  | { event: "error"; message: string }
  | { event: "other"; name: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The event a line carries; undefined for any other line, or one with fields that do not hold. */
export function eventOf(line: string): LauncherEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.sanoma !== 1 || typeof parsed.event !== "string") return undefined;
  const { event, url, sites, message } = parsed;
  if (event === "ready") {
    if (typeof url !== "string") return undefined;
    const named = isRecord(sites)
      ? Object.fromEntries(
          Object.entries(sites).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : {};
    return { event, url, sites: named };
  }
  if (event === "error") return { event, message: typeof message === "string" ? message : "the launcher failed" };
  return { event: "other", name: event };
}

/** The line a launcher without events prints once the app listens (sanoma 0.6.0 and before). */
const LISTENING = / at (http:\/\/\S+); ctrl-c to stop$/;

/** Where the app is, from the launcher's human line `<app> at <url>; ctrl-c to stop`. */
export function listeningUrlOf(line: string): string | undefined {
  return LISTENING.exec(line)?.[1];
}

/** Calls `onLine` with each line of `stream`, without its line ending, then `onEnd`. */
export function eachLine(stream: Readable, onLine: (line: string) => void, onEnd?: () => void): void {
  const lines = createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
  if (onEnd) lines.once("close", onEnd);
}
