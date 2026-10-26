/*
 * Events for a parent process (the desktop shell): with `SANOMA_EVENTS=1`, one JSON object per
 * line on stdout, `{"sanoma":1,"event":…}`, beside the lines a person reads; logs stay on stderr.
 */

import type { CheckResult } from "@sanoma-ai/workflows";

/** What the launcher tells a parent process. */
export type SanomaEvent =
  /** The app listens at `url`, each public site at its own host (`{}` for none); again after each restart. */
  | { event: "ready"; url: string; sites: Record<string, string> }
  /** The launcher failed, with what it printed on stderr; the exit code follows (2 usage or config, 1 failure). */
  | { event: "error"; message: string }
  /** The database: one that answered, started or created on this computer. */
  | { event: "database"; how: "answered" | "started" | "created"; url: string; place: "this-computer" }
  /** `sanoma check`'s result, after the lines it printed, before its exit (1 when not `ok`), with the repo's Permissions grid (`grid`) unless its policies do not hold. */
  | ({ event: "checked" } & CheckResult);

/** Whether a parent process asked for events (`SANOMA_EVENTS=1`). */
export const eventsOn = () => process.env.SANOMA_EVENTS === "1";

/** Writes `event` as one line on stdout when `SANOMA_EVENTS=1`; nothing otherwise. */
export function emit(event: SanomaEvent): void {
  if (eventsOn()) process.stdout.write(`${JSON.stringify({ sanoma: 1, ...event })}\n`);
}
