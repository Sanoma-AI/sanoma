import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import type { ApplyReport } from "./apply.ts";
import type { AppAction, AppRunner, AppStepContext, AppSteps } from "./app-workflows.ts";
import type { ResolvedConfig, SanomaConfig } from "./config.ts";
import { causes, isRunControlError } from "./errors.ts";
import { type Run, runNow } from "./run.ts";
import { APPLY_WORKFLOW, errorMessage } from "./shared.ts";

// The app's built-ins' steps (`app-workflows.ts` is held to the workflow lint and imports no
// DBOS): each app step in a DBOS step of its own, given what the worker has (`WorkerState.appSteps`),
// and the apply after it started as a child run (`child`, the change workflow's deploy's too).
// Each reads its run from `currentRun`.

/** What a worker started with the app's steps keeps for them (`WorkerState.appSteps`). */
export interface WorkerApp {
  steps: AppSteps;
  config: SanomaConfig;
  resolved: ResolvedConfig;
  /** `WorkerOptions.loopbackLogin`. */
  loopbackLogin: boolean;
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

/**
 * Starts a run of the built-in `name` as a child of this one, with the id `<run>:<suffix>` (so a
 * replay finds it), as the run's own actor, and waits for its output, counted as a wait for
 * another run: undefined and the error's message when it failed, or was cancelled (a worker on a
 * new version cancels an apply started on other code, `carryBuiltInRuns`).
 */
export async function child(
  run: Run,
  name: string,
  suffix: string,
  input: unknown,
): Promise<{ runId: string; output?: unknown; error?: string }> {
  const runId = `${run.id}:${suffix}`;
  const handle = await run.state.startRun(name, runId, {
    input,
    startedBy: run.actor,
    ...(run.sandbox !== undefined && { sandbox: run.sandbox }),
  });
  try {
    return { runId, output: await run.state.deadlines.waiting(run.id, { kind: "run" }, () => handle.getResult()) };
  } catch (err) {
    // The child's cancellation, not this run's own (`DBOSWorkflowCancelledError`, which ends it).
    if (causes(err).some((e) => e instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError))
      return { runId, error: "it was cancelled: the worker restarted on a new version before it ended" };
    if (isRunControlError(err)) throw err;
    return { runId, error: errorMessage(err) };
  }
}

/** What the run's app step is given (`AppStepContext`): the worker's own client, connected on first use, and what the worker has. */
export async function stepContext(run: Run, { config, resolved, loopbackLogin }: WorkerApp): Promise<AppStepContext> {
  const { state } = run;
  return {
    client: await state.client(),
    ...(state.source && { source: state.source }),
    ...(state.reload && { reload: state.reload }),
    serially: state.serially,
    config,
    resolved,
    loopbackLogin,
    by: run.actor,
    runId: run.id,
  };
}

/** The app's step `name` with `input`, in a DBOS step of the run's named `stepName` (`app:<name>`). */
export function step(run: Run, name: AppAction | "check", input: unknown, stepName = `app:${name}`): Promise<any> {
  return DBOS.runStep(
    async () => {
      const app = appStepsOf(run, NO_APP_STEPS);
      return (app.steps[name] as (step: AppStepContext, input: unknown) => Promise<unknown>)(
        await stepContext(run, app),
        input,
      );
    },
    { name: stepName },
  );
}

/** The runner the app's built-ins run their work through. */
export const appRunner: AppRunner = {
  step: (name, input) => step(runNow("An app step"), name, input) as ReturnType<AppSteps[typeof name]>,
  reload() {
    const { reload } = runNow("An app step").state;
    return DBOS.runStep(
      async () => {
        reload?.();
        return reload !== undefined;
      },
      { name: "app:reload" },
    );
  },
  async stepThenApply(name, input) {
    const run = runNow("An app step");
    const { apply, ...rest } = await step(run, name, input);
    // Its child, as its own actor, not waited for: an apply may wait for its plan's approval.
    const runId = `${run.id}:apply`;
    await run.state.startRun(APPLY_WORKFLOW, runId, { input: apply, startedBy: run.actor });
    return { ...rest, runId };
  },
  async applyAndWait(apply) {
    const { runId, output, error } = await child(runNow("An app step"), APPLY_WORKFLOW, "apply", apply);
    if (error !== undefined) throw new Error(`Apply did not finish: ${error}`);
    const { results, plan } = output as ApplyReport;
    // A step that failed or was skipped, and a resource asked for that apply made no step of
    // (its plan failed, as `plan.problems` says): either leaves going live undone.
    const unplanned = (apply.only ?? []).filter((id) => !results.some((r) => r.id === id));
    const undone = [
      ...results.filter((r) => r.status !== "done").map((r) => `${r.id} ${r.error ?? r.status}`),
      ...unplanned.map((id) => `${id} was not applied`),
      ...(unplanned.length ? plan.problems.map((p) => p.message) : []),
    ];
    if (undone.length) throw new Error(`Apply did not finish: ${undone.join("; ")}`);
    return { runId };
  },
};
