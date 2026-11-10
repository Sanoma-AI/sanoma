import type { Readable } from "node:stream";
import { createInterface } from "node:readline";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The record a line a launcher started with `SANOMA_EVENTS=1` prints on stdout for its parent carries (#286 L1). */
function recordOf(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return isRecord(parsed) && parsed.sanoma === 1 ? parsed : undefined;
}

/** Whether a line is one of the launcher's events, of any kind: for the shell, not for reading. */
export const isEventLine = (line: string) => recordOf(line) !== undefined;

/**
 * Whether a line is the launcher's `database` event: a new company is set up, and its database is
 * there (`createSession`).
 */
export const isDatabaseEvent = (line: string) => recordOf(line)?.event === "database";

/**
 * The stage a line of `sanoma init` begins, `{"sanoma":1,"event":"stage","stage":…,"status":"start"}`:
 * `template`, `people`, `git`, `install` or `database`. Undefined for any other line.
 */
export function startedStage(line: string): string | undefined {
  const record = recordOf(line);
  return record?.event === "stage" && record.status === "start" && typeof record.stage === "string"
    ? record.stage
    : undefined;
}

/**
 * The event a line carries that the shell acts on: `{"sanoma":1,"event":"ready","url":…,"sites":{…}}`
 * or `{"sanoma":1,"event":"error","message":…}`. Undefined for any other line, another event
 * (`database`, `isDatabaseEvent`; `stage`, `startedStage`) or one with fields that do not hold.
 */
export function eventOf(
  line: string,
): { event: "ready"; url: string } | { event: "error"; message: string } | undefined {
  const record = recordOf(line);
  if (!record) return undefined;
  const { event, url, message } = record;
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
