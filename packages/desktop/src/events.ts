import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The event a line a launcher started with `SANOMA_EVENTS=1` prints on stdout for its parent
 * carries (#286 L1): `{"sanoma":1,"event":"ready","url":…,"sites":{…}}` or
 * `{"sanoma":1,"event":"error","message":…}`. Undefined for any other line, another event
 * (`database`, which the shell only logs) or one with fields that do not hold.
 */
export function eventOf(
  line: string,
): { event: "ready"; url: string } | { event: "error"; message: string } | undefined {
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.sanoma !== 1) return undefined;
  const { event, url, message } = parsed;
  if (event === "ready") return typeof url === "string" ? { event, url } : undefined;
  if (event === "error") return { event, message: typeof message === "string" ? message : "the launcher failed" };
  return undefined;
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
