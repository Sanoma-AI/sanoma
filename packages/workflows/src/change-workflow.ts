import type {
  ChangeDecision,
  ChangeDeploy,
  ChangeEvent,
  ChangeFacts,
  ChangeReport,
  ChangeState,
  ChangeVerified,
  changeOps,
  MergeInput,
} from "./change.ts";
import { ADMIN, ChangeInput, initialChangeState } from "./change.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { errorCode, isRunControlError, type SanomaError } from "./errors.ts";
import { approverLabel, type CHANGE_WORKFLOW, errorMessage } from "./shared.ts";
import type { CheckResult } from "./source.ts";

// The built-in `change` workflow: the life of a change to the company's repository, from its
// draft to live. It opens the draft's branch as a pull request, checks and plans it, asks the
// policy, reports Sanoma's review on the host, waits in the Inbox for Publish (the approval),
// squash-merges, deploys and verifies. A workflow like any other, held to the same lint: every
// operation goes through `ctx`, and what is no operation is a step of `change-steps.ts`.

/** What the change workflow does that is no operation, each a step of its own (`change-steps.ts`). */
export interface ChangeSteps {
  /** `sanoma check` on the draft (`Source.check`), its Permissions grid among it. */
  check(id: string): Promise<CheckResult>;
  /** The facts the policy decides the merge on: from the draft's diff, the waiting runs and `check`. */
  plan(id: string, check: CheckResult): Promise<ChangeFacts>;
  /** The policy's answer to the merge now, the runtime's rule first: who Publish waits for, or why it is denied. */
  ahead(merge: MergeInput): Promise<ChangeDecision>;
  /** Waits for the next event on the change's topic: the one that weighs most of those waiting then, a `merged` or `closed` checked on the host for pull request `number`. */
  next(number: number): Promise<ChangeEvent>;
  /** The event that weighs most of those waiting on the topic now, without waiting, checked as `next` does; undefined for none. */
  queued(number: number): Promise<ChangeEvent | undefined>;
  /** Withdraws every approval of the run approved for the merge, saying `reason`: none lifts a hold on a newer head. */
  retire(reason: string): Promise<void>;
  /** After the merge: the checkout follows `main`, then apply on the declared hosts, as a run of its own this one waits for. */
  deploy(sha: string): Promise<ChangeDeploy>;
  /** After an apply on the hosts: drift on them, as a run of its own; undefined with no host. */
  verify(deploy: ChangeDeploy): Promise<ChangeVerified | undefined>;
  /** Closes the draft the change merged. */
  closeDraft(id: string): Promise<void>;
  /** Publishes where the change is (`CHANGE_EVENT`), for the app. */
  publish(state: ChangeState): Promise<void>;
}

/** What the change workflow uses: its four operations, and `approval`. */
type ChangeUse = (typeof changeOps.change)[keyof typeof changeOps.change] | "approval";

/** The approval Publish is: the Inbox's title for it. */
const PUBLISH = "Publish the change";

/** The `sanoma` status on the host: pending while it can merge, failure while checks fail or the policy denies; and what it waits for. */
function reviewOf(decision: ChangeDecision, facts: ChangeFacts): { state: "pending" | "failure"; description: string } {
  if (decision.answer === "deny") {
    return { state: "failure", description: `Denied: ${decision.reason ?? "the policy refuses it"}` };
  }
  const waits = decision.title ?? `Waits for ${approverLabel(decision.approver ?? { group: ADMIN })} to publish it`;
  return facts.checksOk
    ? { state: "pending", description: waits }
    : { state: "failure", description: `sanoma check fails. ${waits}` };
}

/**
 * The change workflow over `ops` (`changeOps`, the built-in connector's) and `steps`:
 * `resolveConfig` adds it to every config. It `uses` the four operations and `approval`.
 *
 * A run is the life of one change (run id `change:<draft>`): each round opens the draft's branch
 * as a pull request (`open`, which pushes it), checks it (`steps.check`), plans its facts
 * (`steps.plan`), asks the policy ahead (`steps.ahead`), and reports on the host (`review`). While
 * the policy denies it, the run waits for what happens next (`steps.next`). Otherwise it asks one
 * approval, Publish, of the hold's approver (else whoever drafted it), covering the merge, with the
 * change and its facts as its details; once approved, it merges (`merge`). An event that comes in
 * meanwhile (`SanomaClient.changeEvent`) withdraws the approval, and the run reads it:
 * `commits` plans another round, after withdrawing every approval approved for the merge
 * (`steps.retire`), so none lifts a hold on the new head; `close` closes the pull request; the
 * pull request `closed` or `merged` on the host ends the change as it is. A rejected Publish
 * closes it too. A merge whose branch moved plans another round; one the host refuses waits.
 *
 * Once merged, the deploy (`steps.deploy`): the checkout follows `main`, then apply on the
 * declared hosts, as a run this one waits for, then drift on them (`steps.verify`). A `merged` or
 * `closed` event someone told is checked on the host as it is read (`steps.next`, `steps.queued`); one it does not bear
 * out plans another round. A Publish withdrawn with no event waits, blocked, for the next one.
 * Then the draft is closed. Each phase is published (`steps.publish`, `CHANGE_EVENT`); the run's
 * output is its `ChangeReport`.
 */
export function changeWorkflow(
  ops: typeof changeOps,
  steps: ChangeSteps,
): WorkflowDefinition<readonly ChangeUse[], typeof ChangeInput> {
  return defineWorkflow({
    // The literal, held to the one name: the outline finds a workflow by a string, or a const of its own file.
    name: "change" satisfies typeof CHANGE_WORKFLOW,
    title: "Publish a change",
    trigger: "manual",
    input: ChangeInput,
    uses: [ops.change.open, ops.change.review, ops.change.merge, ops.change.close, "approval"],
    run: async (ctx, input) => {
      const state = initialChangeState(input);
      /** Moves the change on, and publishes where it is. */
      const show = (patch: Partial<ChangeState>) => {
        Object.assign(state, patch);
        return steps.publish(state);
      };
      let report: ChangeReport | undefined;
      while (report === undefined) {
        // An approval is given for a head: one approved for an earlier round lifts no hold on this one.
        await steps.retire("the change was planned again at a new head");
        await show({ phase: "opening", decision: undefined, blocked: undefined });
        const opened = await ctx.sanoma.change.open(input);
        const pullRequest = { number: opened.number, url: opened.url };
        await show({ branch: opened.branch, pullRequest, head: opened.head, phase: "checking" });
        const check = await steps.check(input.id);
        await show({ check, phase: "planning" });
        const facts = await steps.plan(input.id, check);
        const merge = { id: input.id, number: opened.number, head: opened.head, title: input.title, facts };
        const decision = await steps.ahead(merge);
        await show({ facts, decision, phase: "reviewing" });
        await ctx.sanoma.change.review({
          id: input.id,
          number: opened.number,
          head: opened.head,
          ...reviewOf(decision, facts),
          ...(input.page !== undefined && { page: input.page }),
        });
        // What came in while the round was planned decides it before any approval is asked.
        let told = await steps.queued(opened.number);
        let event: ChangeEvent | undefined;
        let blocked = told === undefined && decision.answer === "deny" ? decision.reason : undefined;
        if (told === undefined && blocked === undefined) {
          try {
            await show({ phase: "waiting" });
            await ctx.approval(PUBLISH, {
              approver: decision.approver!,
              covers: [ops.change.merge],
              details: JSON.stringify({ change: { id: input.id, title: input.title, branch: opened.branch }, facts }),
              links: [opened.url, ...(input.page === undefined ? [] : [input.page])],
            });
            // An event told while Publish was being asked found no approval to withdraw: it is read before the merge.
            told = await steps.queued(opened.number);
            if (told === undefined) {
              await show({ phase: "merging" });
              let merged: Awaited<ReturnType<typeof ctx.sanoma.change.merge>>;
              try {
                merged = await ctx.sanoma.change.merge(merge);
              } catch (err) {
                // Approved, but the policy or the host refuses the merge now: the change waits, as for a refusal.
                // A hold the policy puts on the merge itself is decided as Publish is, below.
                if (isRunControlError(err) || errorCode(err)?.startsWith("approval_")) throw err;
                merged = { outcome: "blocked", reason: errorMessage(err) };
              }
              if (merged.outcome === "merged") event = { kind: "merged", sha: merged.sha ?? opened.head };
              else if (merged.outcome === "closed") event = { kind: "closed" };
              else if (merged.outcome === "moved") event = { kind: "commits" };
              else blocked = merged.reason ?? "the host refuses the merge";
            }
          } catch (err) {
            // A withdrawal comes with an event, else Publish was taken back. A rejection of Publish closes the change.
            const code = errorCode(err);
            if (code === "approval_withdrawn") {
              told = await steps.queued(opened.number);
              if (told === undefined) blocked = "Publish was withdrawn";
            } else if (code === "approval_rejected") {
              event = { kind: "close", by: ((err as SanomaError).data.by as { id: string }).id };
            } else throw err;
          }
        }
        if (blocked !== undefined) {
          await show({ phase: "blocked", blocked });
          told = await steps.next(opened.number);
        }
        event ??= told!;
        if (event.kind === "merged") {
          await show({ phase: "deploying" });
          const deploy = await steps.deploy(event.sha);
          const verified = await steps.verify(deploy);
          await steps.closeDraft(input.id);
          const merged = { sha: event.sha, at: await ctx.now(), deploy, ...(verified && { verified }) };
          await show({ phase: "merged", merged });
          report = {
            outcome: "merged",
            head: opened.head,
            pullRequest,
            sha: merged.sha,
            deploy,
            ...(verified && { verified }),
          };
        } else if (event.kind !== "commits") {
          if (event.kind === "close") await ctx.sanoma.change.close({ id: input.id, number: opened.number });
          await show({ phase: "closed", ...(event.kind === "close" && { closedBy: event.by }) });
          report = { outcome: "closed", head: opened.head, pullRequest };
        }
      }
      return report;
    },
  });
}
