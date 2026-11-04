// What the shell's own pages show, worked out from what the main process sends. No Node and no
// Electron, as the pages in start/ import it too.
import type { LogTail } from "./logs.ts";

/** How a company came to the window: its folder opened, a new one, or a copy from GitHub. */
export type Kind = "open" | "new" | "clone";

/** What a company's own page shows (`start/company.html`): its start, or why it stopped. */
export interface CompanyState {
  path: string;
  name: string;
  /** Its folder, the home folder as `~`. */
  place: string;
  kind: Kind;
  /** `running`: the app answers, and the window shows it once it has loaded (`showsApp`). */
  phase: "starting" | "running" | "failed" | "stopped";
  progress: string[];
  log: LogTail;
  /** When this start began, and when it last printed a line (epoch milliseconds). */
  startedAt: number;
  lastOutputAt: number;
  /** Why it failed, and that in two words. */
  message?: string;
  pill?: string;
  /** Why its folder may break it, until the person has read it (`Company.warned`): the app waits for that. */
  warning?: string;
  /** Whether a start shows its output: the person's Show details, for every company (`Settings.details`). */
  details: boolean;
  /** Whether the next launch opens it again (`Company.open`): a failed one offers not to. */
  reopens: boolean;
  /** What brings a closed window back here. */
  bringsBack: "Dock" | "tray";
}

/** What a session reports (`onProgress`) as it goes on to install and to start. */
export const CLONING = "Cloning";
export const INSTALLING = "Installing packages";
export const STARTING = "Starting the company";

const INSTALL_AND_START = ["Installing what it needs", "Starting the company"];
const STEPS: Record<Kind, string[]> = {
  open: INSTALL_AND_START,
  new: ["Setting up the company", "Starting it"],
  clone: ["Copying from GitHub", ...INSTALL_AND_START],
};

export interface Step {
  label: string;
  status: "done" | "now" | "next";
}

/**
 * The start's steps, all of them from the beginning: the ones behind the last thing the session
 * reported are done. A new company reports twice (`createSession`), and a copy from GitHub that is
 * already there skips its first. Done all through once only Got it holds the app back.
 */
export function stepsOf({
  kind,
  phase,
  progress,
  warning,
}: Pick<CompanyState, "kind" | "phase" | "progress" | "warning">): Step[] {
  const labels = STEPS[kind];
  const last = progress.at(-1);
  const now = last === STARTING ? labels.length - 1 : last === INSTALLING ? labels.length - 2 : 0;
  const waiting = phase === "running" && warning;
  return labels.map((label, index) => ({
    label,
    status: waiting || index < now ? "done" : index === now ? "now" : "next",
  }));
}

/** How long an opening company shows only its name and one word: most are in their app by then. */
export const OPENING_MS = 3_000;
/** How long a start prints nothing before the page says so. A guess until a slow network sets it. */
export const QUIET_MS = 120_000;

export interface CompanyPage {
  /** It has failed or stopped: no steps, and Start again. */
  ended: boolean;
  /** Only the name and one word, so that a fast open does not flash a list. */
  opening: boolean;
  /** No output for `QUIET_MS`: it says so, and stops nothing. */
  quiet: boolean;
  steps: Step[];
  /** The step under way. */
  step?: string;
  /** How long this takes, and that the window may close: a new company's first start is the long one. */
  note?: string;
  closing?: string;
  /** The line for whoever did not set it up: a company that was opened, and whose reason is about its code. */
  sendDetails: boolean;
  pill?: string;
  /** When this changes with nothing else happening, so the page draws itself again then. */
  changesAt?: number;
}

/** What a company's page shows of `state` at the time `now`. */
export function companyPage(state: CompanyState, now: number): CompanyPage {
  const { kind, phase, startedAt, lastOutputAt, details, warning, bringsBack } = state;
  const ended = phase === "failed" || phase === "stopped";
  const opening = !ended && kind === "open" && !warning && !details && now < startedAt + OPENING_MS;
  const quietAt = lastOutputAt + QUIET_MS;
  const quiet = phase === "starting" && now >= quietAt;
  const steps = stepsOf(state);
  const isNew = !ended && kind === "new";
  return {
    ended,
    opening,
    quiet,
    steps,
    step: steps.find((step) => step.status === "now")?.label,
    ...(isNew && {
      note: "This takes about a minute, the first time.",
      closing: `You can close this window. Sanoma keeps going, and the ${bringsBack} icon brings it back.`,
    }),
    sendDetails: phase === "failed" && kind === "open",
    pill: phase === "stopped" ? "Stopped" : state.pill,
    changesAt: opening ? startedAt + OPENING_MS : phase === "starting" && !quiet ? quietAt : undefined,
  };
}

/**
 * The folder a new company called `name` gets: lower case, accents off, anything else that is not
 * a letter or a number a single hyphen. Empty when nothing is left.
 */
export const folderNameOf = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
