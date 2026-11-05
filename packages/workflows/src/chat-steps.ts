import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { appStepsOf, stepContext } from "./app-steps.ts";
import type { ChatSteps, ChatTurnOutput } from "./chat-workflow.ts";
import { ChatTell } from "./chat-workflow.ts";
import { isRunControlError } from "./errors.ts";
import { warn } from "./log.ts";
import { runNow } from "./run.ts";
import { openChatCode } from "./seal.ts";
import { CHAT_TOPIC } from "./shared.ts";

// The chat workflow's steps (`chat-workflow.ts` is held to the workflow lint and imports no DBOS):
// the wait for the turn before, the turn itself in a step of its own (the app's `AppSteps.chat`,
// given what an app step is), and what the run is told meanwhile, handed to the turn under way
// through the turns these steps keep. The turn's step and the run's `recv`s run side by side:
// DBOS numbers each call as it is made, so a replay meets them in the same order.

/** What a worker without the app's steps answers a chat turn: its run fails at once, saying where the agent runs. */
export const NO_CHAT_STEPS =
  "No agent runs on this instance's worker: chat from the Mac app, or where `sanoma dev` or `sanoma serve` runs the company's checkout";

/** How long one `recv` waits before it asks again; a turn waits for its person's sign-in as long as it lets them. */
const RECV_SECONDS = 24 * 60 * 60;

/** A chat turn under way: how to stop it, and who takes a code pasted for its sign-in. */
interface LiveTurn {
  stop: AbortController;
  code?: (code: string) => void;
}

/** The chat workflow's steps. */
export function chatSteps(): ChatSteps {
  /** Each turn under way in this process, by its run's id: what `tell` hands a message to the run to. */
  const turns = new Map<string, LiveTurn>();
  return {
    async after(runId) {
      const run = runNow("A chat step");
      try {
        await run.state.deadlines.waiting(run.id, { kind: "run" }, () => DBOS.retrieveWorkflow(runId).getResult());
      } catch (err) {
        // However the turn before ended, it has: a failed or cancelled one too.
        if (isRunControlError(err) && !(err instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError)) throw err;
      }
    },

    turn(input) {
      const run = runNow("A chat step");
      // Thrown, not a rejection: the run fails at once, before it waits for an end no turn would tell.
      const app = appStepsOf(run, NO_CHAT_STEPS);
      const live: LiveTurn = { stop: new AbortController() };
      // Kept for `tell` before the step starts, so a stop it reads at once finds the turn.
      turns.set(run.id, live);
      const done = DBOS.runStep(
        async (): Promise<ChatTurnOutput> => {
          try {
            const step = await stepContext(run, app);
            const resumed = !(await step.client.chats.begin(input.chat, run.id));
            return await app.steps.chat(
              {
                ...step,
                // Stopped by a new message, or once the worker has stopped, so no agent goes on without it.
                signal: AbortSignal.any([live.stop.signal, run.state.shutdown]),
                onCode(listener) {
                  live.code = listener;
                  return () => {
                    if (live.code === listener) live.code = undefined;
                  };
                },
                resumed,
              },
              input,
            );
          } finally {
            // From the step: DBOS keeps no record of it, and a step done again tells it again.
            await DBOS.send(run.id, { kind: "ended" } satisfies ChatTell, CHAT_TOPIC);
          }
        },
        { name: "chat:turn" },
      );
      const forget = () => {
        if (turns.get(run.id) === live) turns.delete(run.id);
      };
      // The run awaits it once `tell` says it ended: handled meanwhile, so its failure is not unhandled.
      done.then(forget, forget);
      return done;
    },

    async tell() {
      const run = runNow("A chat step");
      // No deadline: the turn's step is executing all the while, so the run is busy, not waiting.
      const raw = await DBOS.recv<unknown>(CHAT_TOPIC, { timeoutSeconds: RECV_SECONDS });
      if (raw === null || raw === undefined) return true;
      const told = ChatTell.safeParse(raw);
      if (!told.success) {
        warn(`run ${run.id}: a message on ${CHAT_TOPIC} is none a chat turn takes, so it is ignored`);
        return true;
      }
      const live = turns.get(run.id);
      if (told.data.kind === "ended") return false;
      if (told.data.kind === "stop") live?.stop.abort();
      else {
        const code = openChatCode(told.data.sealed, run.id);
        if (code === undefined) warn(`run ${run.id}: a sign-in code not sealed for it is ignored`);
        else live?.code?.(code);
      }
      return true;
    },
  };
}
