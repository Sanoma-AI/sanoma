import type { HostOutputs } from "sanoma/workflows";
import { hostnameUrl, isEnded } from "sanoma/workflows/shared";
import { type CompanyState, GO_LIVE_LINES, type GoLiveRun, INFRA, type Place } from "../api.ts";

// A company's one state, from facts, never from how it was made: what the bar's badge says, what
// Home's last step ticks (`isLive`) and which panel Hosting shows. `companyState`
// (server/company-state.ts) gathers the facts; this file only reads them, so the tests call it
// with facts of their own.

/** What a company's state is read from. */
export interface CompanyFacts {
  /** The declarations the lockfile binds, by key (`<file>#<export>`). */
  bound: readonly string[];
  /** Where this instance is (`placeOf`). */
  place: Place;
  declared: CompanyState["declared"];
  /** Whether the company's repository is online: `origin` is set, or `infra.ts`'s repository is bound. */
  repository: boolean;
  /** Going live's latest run: its apply once it started one, else the run itself. */
  run: GoLiveRun | null;
  /** Where the host answers (`hostAt`), and whether `/healthz` did when it was asked. */
  host?: { url: string; healthy?: boolean } | undefined;
}

/** The lockfile's key of what `infra.ts` declares as `name`. */
const key = (name: string) => `${INFRA}#${name}`;

/** Whether the company runs online: its host bound, or this instance a hosted one. */
export const isLive = (bound: readonly string[], place: Place) => bound.includes(key("host")) || place === "live";

/** A run of going live that failed: ended so, or ended with a step that failed (an apply's host, say). */
const failed = (run: GoLiveRun) =>
  run.status === "failed" || run.status === "cancelled" || (run.results?.some((r) => r.status === "failed") ?? false);

/**
 * The company's state: going live's run not ended is `deploying`; else its host bound (or this
 * instance a hosted one) is `live`; else going live's latest run having failed is `failed`; else
 * `local`. A copy of a live company opened on this computer is its drafting copy.
 */
export function companyStateOf({ bound, place, declared, repository, run, host }: CompanyFacts): CompanyState {
  const hostBound = bound.includes(key("host"));
  const live = isLive(bound, place);
  const state = run && !isEnded(run.status) ? "deploying" : live ? "live" : run && failed(run) ? "failed" : "local";
  const done = {
    repository,
    database: bound.includes(key("store")),
    host: hostBound,
    signIn: hostBound && host?.healthy === true,
  };
  return {
    state,
    draftingCopy: live && place === "this-computer",
    declared,
    lines: GO_LIVE_LINES.map((line) => ({ line, done: done[line] })),
    run,
    host: host ?? null,
  };
}

/**
 * Where the host answers: as the latest apply that made or changed it says (`applied`), else as
 * the latest drift check read it (`checked`), else at the hostname it declares; none without any.
 */
export const hostAt = ({
  applied,
  checked,
  hostname,
}: {
  applied?: HostOutputs | undefined;
  checked?: HostOutputs | undefined;
  hostname?: string | undefined;
}): Pick<HostOutputs, "url" | "wakeUrl"> | undefined =>
  applied ?? checked ?? (hostname ? { url: hostnameUrl(hostname) } : undefined);
