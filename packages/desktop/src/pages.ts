// What the shell's own pages show, worked out from what the main process sends. No Node and no
// Electron, as the pages in start/ import it too.
import type { LogTail } from "./logs.ts";

/** How a company came to the window: its folder opened, a new one, or a copy from GitHub. */
export type Kind = "open" | "new" | "clone";

/** What a company's own page shows (`start/company.html`): its start, or why it stopped. */
export interface CompanyState {
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
/** What a new company's init reports before it installs (its `stage` events), and once its database answers. */
export const FROM_TEMPLATE = "Copying the starter";
export const ADDING_YOU = "Adding the founder";
export const OPENING = "Opening the app";

const INSTALL_AND_START = [
  { label: "Installing what it needs", reportedBy: INSTALLING },
  { label: "Starting the company", reportedBy: STARTING },
];
const STEPS: Record<Kind, { label: string; reportedBy: string }[]> = {
  open: INSTALL_AND_START,
  new: [
    { label: "Making the company from the starter", reportedBy: FROM_TEMPLATE },
    { label: "Adding you as its admin", reportedBy: ADDING_YOU },
    { label: "Installing what it needs", reportedBy: INSTALLING },
    { label: "Starting its database on this computer", reportedBy: STARTING },
    { label: "Opening it", reportedBy: OPENING },
  ],
  clone: [{ label: "Copying from GitHub", reportedBy: CLONING }, ...INSTALL_AND_START],
};

export interface Step {
  label: string;
  status: "done" | "now" | "next";
}

/**
 * The start's steps, all of them from the beginning: the one the session reported last is under
 * way, and those before it are done (a copy from GitHub that is there already skips its first, a
 * new company tried again in a folder that got that far its first two). A report no step has (a
 * launcher without `stage` events says nothing until its database answers) moves nothing. Done
 * all through once only Got it holds the app back.
 */
export function stepsOf({
  kind,
  phase,
  progress,
  warning,
}: Pick<CompanyState, "kind" | "phase" | "progress" | "warning">): Step[] {
  const steps = STEPS[kind];
  const reported = progress.findLast((said) => steps.some((step) => step.reportedBy === said));
  const now = Math.max(
    0,
    steps.findIndex((step) => step.reportedBy === reported),
  );
  const waiting = phase === "running" && warning;
  return steps.map(({ label }, index) => ({
    label,
    status: waiting || index < now ? "done" : index === now ? "now" : "next",
  }));
}

/** How long an opening company shows only its name and one word: most are in their app by then. */
export const OPENING_MS = 3_000;
/** How long a start prints nothing before the page says so. A guess until a slow network sets it. */
export const QUIET_MS = 120_000;

export interface CompanyPage {
  /** A narrow column, or the whole window once there is output or a reason to show. */
  layout: "column" | "wide";
  /** It has failed or stopped: no steps, and Start again. */
  ended: boolean;
  /** Its output shows: asked for, or, whatever was asked, a failure's unless that page hid it. */
  output: boolean;
  /** The steps show, in a list: a start under way, with room for them. */
  listed: boolean;
  /** The one thing said beside the name: one word while it opens, so that a fast open does not flash a list, else the step under way once the output takes the list's place. */
  current?: string;
  /** Show details and Stop show: a failure's output has its own Hide. */
  controls: boolean;
  /** No output for `QUIET_MS`: it says so, and stops nothing. */
  quiet: boolean;
  steps: Step[];
  /** How long this takes, and that the window may close: a new company's first start is the long one. */
  note?: string;
  closing?: string;
  /** The line for whoever did not set it up: a company that was opened, and whose reason is about its code. */
  sendDetails: boolean;
  pill?: string;
  /** When this changes with nothing else happening, so the page draws itself again then. */
  changesAt?: number;
}

/** What a company's page shows of `state` at the time `now`; `hiddenOnFailure` is that page's own Hide. */
export function companyPage(state: CompanyState, now: number, hiddenOnFailure = false): CompanyPage {
  const { kind, phase, startedAt, lastOutputAt, details, warning, bringsBack } = state;
  const failed = phase === "failed";
  const ended = failed || phase === "stopped";
  const output = failed ? !hiddenOnFailure : details;
  const opening = !ended && kind === "open" && !warning && !details && now < startedAt + OPENING_MS;
  const quietAt = lastOutputAt + QUIET_MS;
  const quiet = phase === "starting" && now >= quietAt;
  const steps = stepsOf(state);
  const step = steps.find(({ status }) => status === "now")?.label;
  const isNew = !ended && kind === "new";
  return {
    layout: ended || output ? "wide" : "column",
    ended,
    output,
    listed: !ended && !output && !opening,
    current: opening ? "Opening" : !ended && output ? step : undefined,
    controls: !opening && !(failed && output),
    quiet,
    steps,
    ...(isNew && {
      note: "This takes about a minute, the first time.",
      closing: `You can close this window. Sanoma keeps going, and the ${bringsBack} icon brings it back.`,
    }),
    sendDetails: failed && kind === "open",
    pill: phase === "stopped" ? "Stopped" : state.pill,
    changesAt: opening ? startedAt + OPENING_MS : phase === "starting" && !quiet ? quietAt : undefined,
  };
}

/**
 * The folder a new company called `name` gets: lower case, Latin letters' accents off (other
 * scripts' marks are part of their letters), anything else that is not a letter or a number a
 * single hyphen. Empty when nothing is left.
 */
export const folderNameOf = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    // Names Windows keeps for itself, and a company's folder may end up there.
    .replace(/^(con|prn|aux|nul|com\d|lpt\d)$/, "$1-company");
