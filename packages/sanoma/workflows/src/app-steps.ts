import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ApplyReport } from "./apply.ts";
import type { AppAction, AppRunner, AppStepContext, AppSteps } from "./app-workflows.ts";
import type { ResolvedConfig, SanomaConfig } from "./config.ts";
import { type Run, runNow } from "./run.ts";
import { APPLY_WORKFLOW } from "./shared.ts";

// The app's built-ins' steps (`app-workflows.ts` is held to the workflow lint and imports no
// DBOS): each app step in a DBOS step of its own, given what the worker has (`WorkerState.appSteps`),
// and the apply after it started as a child run. Each reads its run from `currentRun`.

/** What a worker started with the app's steps keeps for them (`WorkerState.appSteps`). */
export interface WorkerApp {
  steps: AppSteps;
  config: SanomaConfig;
  resolved: ResolvedConfig;
}

/** What a worker started without the app's steps answers a run of one of the app's built-ins. */
export const NO_APP_STEPS =
  "This worker runs none of the app's actions: start it with the app's steps (`WorkerOptions.app`), as `sanoma serve` and `sanoma worker` do";

/** The app's steps the run's worker was given; thrown, saying `missing`, when it was given none. */
export function appStepsOf(run: Run, missing: string): WorkerApp {
  const app = run.state.appSteps;
  if (!app) throw new Error(missing);
  return app;
}

/** What the run's app step is given (`AppStepContext`): the worker's own client, connected on first use, and what the worker has. */
export async function stepContext(run: Run, { config, resolved }: WorkerApp): Promise<AppStepContext> {
  const { state } = run;
  return {
    client: await state.client(),
    ...(state.source && { source: state.source }),
    ...(state.reload && { reload: state.reload }),
    serially: state.serially,
    config,
    resolved,
    by: run.actor,
    runId: run.id,
  };
}

/** The app's step `name` with `input`, in a DBOS step of the run's (`app:<name>`). */
function step(run: Run, name: AppAction, input: unknown): Promise<any> {
  const app = appStepsOf(run, NO_APP_STEPS);
  return DBOS.runStep(
    async () =>
      (app.steps[name] as (step: AppStepContext, input: unknown) => Promise<unknown>)(
        await stepContext(run, app),
        input,
      ),
    { name: `app:${name}` },
  );
}

/** The runner the app's built-ins run their work through. */
export const appRunner: AppRunner = {
  step: (name, input) => step(runNow("An app step"), name, input) as ReturnType<AppSteps[typeof name]>,
  async stepThenApply(name, input) {
    const run = runNow("An app step");
    const { apply, ...rest } = await step(run, name, input);
    // Its child, as its own actor, not waited for: an apply may wait for its plan's approval.
    const runId = `${run.id}:apply`;
    await run.state.startRun(APPLY_WORKFLOW, runId, { input: apply, startedBy: run.actor });
    return { ...rest, runId };
  },
  async applyAndWait(apply) {
    const run = runNow("An app step");
    const runId = `${run.id}:apply`;
    const handle = await run.state.startRun(APPLY_WORKFLOW, runId, { input: apply, startedBy: run.actor });
    // Counted as a wait for another run, so the worker is not idle under it.
    const report = (await run.state.deadlines.waiting(run.id, { kind: "run" }, () =>
      handle.getResult(),
    )) as ApplyReport;
    const undone = report.results.filter((r) => r.status !== "done");
    if (undone.length) {
      throw new Error(`Apply did not finish: ${undone.map((r) => `${r.id} ${r.error ?? r.status}`).join("; ")}`);
    }
    return { runId };
  },
};
