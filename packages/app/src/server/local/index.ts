// The seam for what needs the company's checkout: actions that write the repository or run a
// child process (git, Cucumber, a coding agent), and so only where the company's files are. The
// Node adapter's app imports this module; the Worker's bundle replaces it with `none.ts`, so none
// of it, or what it imports, is in the bundle, and each caller answers "not available on this
// host" (501, `notHere`) when `local` is undefined.
// oxlint-disable-next-line import/no-unassigned-import
import "@tanstack/react-start/server-only";
import type { LedgerRecord, RunStatus } from "@sanoma-ai/workflows";
import { isEnded } from "@sanoma-ai/workflows";
import { check, loadScenarios } from "@sanoma-ai/workflows/scenario";
import type { RunDetail } from "../../api.ts";
import type { AppContext } from "../../context.ts";
import { postSignInCode } from "../agent/acp.ts";
import { postChat } from "../agent/turn.ts";
import { notLoaded } from "../core.ts";
import { appBehind } from "./behind.ts";
import { connectExisting } from "./connect.ts";
import { goLive, goLiveHost } from "./go-live.ts";
import { adopt, patch } from "./writes.ts";

/**
 * A sandbox run's checks: Cucumber runs its scenario's Then steps against the ledger, over the
 * feature file as it reads now, which the agent may have changed since.
 */
async function scenarioChecks(
  { resolved }: Pick<AppContext, "resolved">,
  name: string,
  status: RunStatus,
  ledger: LedgerRecord[],
): Promise<Pick<RunDetail, "checks" | "checksError">> {
  const loaded = await loadScenarios(resolved);
  const scenario = loaded.scenarios.find((s) => s.name === name);
  if (!scenario)
    return { checksError: `The feature files no longer have scenario "${name}"${notLoaded(loaded.errors)}` };
  const ended = isEnded(status);
  const checks = (await check(resolved, scenario, ledger)).map((c, i) => {
    const e = scenario.expect[i]!;
    // Met once: a call made, or a decision recorded, stays made.
    return { ...c, settled: ended || (c.ok && (("called" in e && e.called === true) || "decision" in e)) };
  });
  return { checks };
}

const actions = {
  adopt,
  patch,
  appBehind,
  scenarioChecks,
  goLive,
  goLiveHost,
  connectExisting,
  postChat,
  postSignInCode,
};

/** What needs the checkout, as one object. */
export type Local = typeof actions;

/** The actions, here; undefined in the Worker's bundle (`none.ts`). */
export const local: Local | undefined = actions;
