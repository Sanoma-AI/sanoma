import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { type CHAT_WORKFLOW, DRAFT_ID } from "./shared.ts";

// The built-in `chat` workflow: a turn of a person's chat with the operator agent, run by the
// worker, where the agent's harness can run its children in the chat's draft. The app starts it
// (`SanomaClient.startTurn`, as the chat's person, one run per message) and streams the reply the
// turn writes to the database; a new message or a pasted sign-in code reaches the run as a message
// (`ChatTell`). What the turn does is the app's (`AppSteps.chat`), in a step of `chat-steps.ts`; a
// workflow like any other, held to the same lint.

/** A person's message, as a turn takes it: its id (the browser's) and its text. */
const ChatTurnMessage = z.object({
  id: z.string().regex(DRAFT_ID, "a message id is letters, digits, _ and -"),
  role: z.literal("user"),
  parts: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
});

/** A turn's input: the chat, the person's new message, and the chat's turn before it, which this one waits for. */
export const ChatTurnInput = z.object({
  chat: z.string().regex(DRAFT_ID, "a chat id is letters, digits, _ and -"),
  message: ChatTurnMessage,
  after: z.string().min(1).optional(),
});
export type ChatTurnInput = z.infer<typeof ChatTurnInput>;

/** What a turn answers: the reply's message id, once it wrote one; `interrupted` for a turn the worker's restart cut short. */
export interface ChatTurnOutput {
  reply?: string;
  interrupted?: true;
}

/** What a turn's run is told (`CHAT_TOPIC`): stop (a new message came), a sign-in code sealed for the run, its turn's end. */
export const ChatTell = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stop") }),
  z.object({ kind: z.literal("code"), sealed: z.string().min(1) }),
  z.object({ kind: z.literal("ended") }),
]);
export type ChatTell = z.infer<typeof ChatTell>;

/** What a chat turn does, each part a step or a wait of its own (`chat-steps.ts`). */
export interface ChatSteps {
  /** Waits for the chat's turn before this one to end, however it ends: its reply is in the transcript then. */
  after(runId: string): Promise<void>;
  /**
   * The turn, a step that runs while the run reads what it is told (`tell`), and tells the run when
   * it ends. Throws at once, not rejecting, when the worker runs no agent.
   */
  turn(input: ChatTurnInput): Promise<ChatTurnOutput>;
  /** The next thing the run is told, handed to the turn under way: false once the turn has ended. */
  tell(): Promise<boolean>;
}

/** The built-in chat workflow over `steps`: `resolveConfig` adds it to every config. */
export function chatWorkflow(steps: ChatSteps): WorkflowDefinition<any, any> {
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "chat" satisfies typeof CHAT_WORKFLOW,
    title: "A chat turn",
    trigger: "manual",
    input: ChatTurnInput,
    uses: [],
    run: async (_ctx, input): Promise<ChatTurnOutput> => {
      if (input.after !== undefined) await steps.after(input.after);
      const turn = steps.turn(input);
      let open = true;
      while (open) open = await steps.tell();
      return turn;
    },
  });
}
