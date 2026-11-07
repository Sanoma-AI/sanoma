import { z } from "zod";
import type { ChangeEvent } from "./change.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import type { FOLLOW_WORKFLOW } from "./shared.ts";
import type { RemoteEvent } from "./source.ts";

// The built-in `follow` workflow: what a git host's webhook says happened to the company's
// repository, done by the worker, which has the checkout. The app verifies the webhook and starts
// the run (`SanomaClient.follow`, as the runtime's agent `host-check`, one run per event); what it
// does is no operation, so each part is a step of `follow-steps.ts`. A workflow like any other,
// held to the same lint.

const RepoRefSchema = z.object({ owner: z.string().min(1), name: z.string().min(1) });

/** What a host's webhook says happened (`RemoteEvent`): a branch pushed, or a pull request closed (merged or not). */
export const RemoteEventSchema: z.ZodType<RemoteEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pushed"), repo: RepoRefSchema, branch: z.string().min(1), head: z.string().min(1) }),
  z.object({
    kind: z.literal("closed"),
    repo: RepoRefSchema,
    branch: z.string().min(1),
    number: z.number().int(),
    merged: z.boolean(),
    sha: z.string().min(1).optional(),
  }),
]);

/**
 * What a follow did: nothing, saying why (`ignored`); `main` followed, with the run that applies
 * the declared hosts (`deploy:<head>`) when there are any; or the change of a draft told an event.
 */
export type FollowOutput =
  | { ignored: string }
  | { followed: "main"; deploy?: string }
  | { change: string; told: ChangeEvent["kind"] };

/** Where an event lands (`FollowSteps.where`): nothing, saying why; a push to `main`, of its head; or a draft's branch. */
export type FollowTarget = { ignored: string } | { main: string } | { draft: string };

/** What a follow does that is no operation, each a step of its own (`follow-steps.ts`). */
export interface FollowSteps {
  /**
   * Where the event lands: ignored when the worker has no repository, the event is another
   * repository's, or its branch is neither `main` (a push) nor a draft's.
   */
  where(event: RemoteEvent): Promise<FollowTarget>;
  /**
   * After a push of `head` to `main`: the checkout follows it, then apply on the declared hosts as
   * `host-check`, as the run `deploy:<head>`, without waiting for it. Nothing while a change is
   * merging or deploying, which does both itself; throws when the checkout cannot follow.
   */
  main(head: string): Promise<FollowOutput>;
  /**
   * The event for the draft `id`'s open change, when it is one to tell: a push's commits fetched
   * into the draft first (none when the draft or the change is at that head already, or it cannot
   * fast-forward: warned), a closed pull request of this change as `merged` or `closed`.
   */
  draft(event: RemoteEvent, id: string): Promise<{ told: ChangeEvent; key: string } | { ignored: string }>;
  /** Tells the change of the draft `id` the event, once under `key`, as `host-check`: nothing once its run has ended. */
  tell(id: string, told: ChangeEvent, key: string): Promise<void>;
}

/** The built-in follow workflow over `steps`: `resolveConfig` adds it to every config. */
export function followWorkflow(steps: FollowSteps): WorkflowDefinition<any, any> {
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "follow" satisfies typeof FOLLOW_WORKFLOW,
    title: "Follow the repository's host",
    trigger: "manual",
    input: RemoteEventSchema,
    uses: [],
    run: async (_ctx, event): Promise<FollowOutput> => {
      const at = await steps.where(event);
      let output: FollowOutput;
      if ("ignored" in at) output = at;
      else if ("main" in at) output = await steps.main(at.main);
      else {
        const found = await steps.draft(event, at.draft);
        if ("ignored" in found) output = found;
        else {
          await steps.tell(at.draft, found.told, found.key);
          output = { change: at.draft, told: found.told.kind };
        }
      }
      return output;
    },
  });
}
