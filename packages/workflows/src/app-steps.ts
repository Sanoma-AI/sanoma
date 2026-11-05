import { DBOS } from "@dbos-inc/dbos-sdk";
import type { AppRunner, AppSteps } from "./app-workflows.ts";
import type { ResolvedConfig, SanomaConfig } from "./config.ts";
import { currentRun, type Run } from "./run.ts";
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

const runNow = (): Run => {
  const run = currentRun.getStore();
  if (!run) throw new Error("An app step ran outside its run");
  return run;
};

/** The runner the app's built-ins run their work through. */
export const appRunner: AppRunner = {
  step: ((name: keyof AppSteps, input: never) => {
    const run = runNow();
    const app = run.state.appSteps;
    if (!app) throw new Error(NO_APP_STEPS);
    return DBOS.runStep(
      () =>
        run.state.serially(async () =>
          (app.steps[name] as (step: unknown, input: unknown) => Promise<unknown>)(
            {
              client: await run.state.client(),
              ...(run.state.source && { source: run.state.source }),
              config: app.config,
              resolved: app.resolved,
              by: run.actor,
              runId: run.id,
            },
            input,
          ),
        ),
      { name: `app:${name}` },
    );
  }) as AppRunner["step"],

  async apply(input) {
    const run = runNow();
    const runId = `${run.id}:apply`;
    await run.state.startRun(APPLY_WORKFLOW, runId, { input, startedBy: run.actor });
    return runId;
  },
};
