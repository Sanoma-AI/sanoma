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
import { ChangeInput } from "./change.ts";
import { defineWorkflow, type WorkflowDefinition } from "./define.ts";
import { errorCode, type SanomaError } from "./errors.ts";
import type { CHANGE_WORKFLOW } from "./shared.ts";
import type { CheckResult } from "./source.ts";

export { CHANGE_WORKFLOW } from "./shared.ts";

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
  /** Waits for the next event on the change's topic: the one that weighs most of those waiting then. */
  next(): Promise<ChangeEvent>;
  /** The event that weighs most of those waiting on the topic now, without waiting; undefined for none. */
  queued(): Promise<ChangeEvent | undefined>;
  /** Withdraws every approval of the run approved for the merge, saying `reason`: none lifts a hold on a newer head. */
  retire(reason: string): Promise<void>;
  /** After the merge: apply on the declared hosts, as a run of its own this one waits for; with none, the checkout follows `main`. */
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

/** The review card, which this version does not write. */
const NO_CARD = { status: "unavailable", reason: "This version writes no review card on the host" } as const;

/** The `sanoma` status's state on the host: pending while it can merge, failure while checks fail or the policy denies. */
const reviewState = (decision: ChangeDecision, facts: ChangeFacts) =>
  decision.answer === "deny" || !facts.checksOk ? ("failure" as const) : ("pending" as const);

/** The `sanoma` status's description: what the change waits for. */
function reviewOf(decision: ChangeDecision, facts: ChangeFacts): string {
  if (decision.answer === "deny") return `Denied: ${decision.reason ?? "the policy refuses it"}`;
  const who = typeof decision.approver === "string" ? decision.approver : `${decision.approver?.group ?? "admin"}`;
  const checks = facts.checksOk ? "" : "sanoma check fails. ";
  return `${checks}${decision.title ?? `Waits for ${who} to publish it`}`;
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
 * Once merged, the deploy (`steps.deploy`): apply on the declared hosts, as a run this one waits
 * for, then drift on them (`steps.verify`); with no host, the checkout fast-forwarded to `main`.
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
      const state: ChangeState = {
        id: input.id,
        branch: "",
        title: input.title,
        ...(input.page !== undefined && { page: input.page }),
        phase: "opening",
        card: NO_CARD,
      };
      let report: ChangeReport | undefined;
      while (report === undefined) {
        // An approval is given for a head: one approved for an earlier round lifts no hold on this one.
        await steps.retire("the change was planned again at a new head");
        Object.assign(state, { phase: "opening", decision: undefined, blocked: undefined });
        await steps.publish(state);
        const opened = await ctx.sanoma.change.open(input);
        const pullRequest = { number: opened.number, url: opened.url };
        Object.assign(state, { branch: opened.branch, pullRequest, head: opened.head, phase: "checking" });
        await steps.publish(state);
        const check = await steps.check(input.id);
        Object.assign(state, { check, phase: "planning" });
        await steps.publish(state);
        const facts = await steps.plan(input.id, check);
        const merge = { id: input.id, number: opened.number, head: opened.head, title: input.title, facts };
        const decision = await steps.ahead(merge);
        Object.assign(state, { facts, decision, phase: "reviewing" });
        await steps.publish(state);
        await ctx.sanoma.change.review({
          id: input.id,
          number: opened.number,
          head: opened.head,
          state: reviewState(decision, facts),
          description: reviewOf(decision, facts),
          ...(input.page !== undefined && { page: input.page }),
        });
        // What came in while the round was planned decides it before any approval is asked.
        let event = await steps.queued();
        if (event === undefined && decision.answer === "deny") {
          Object.assign(state, { phase: "blocked", blocked: decision.reason });
          await steps.publish(state);
          event = await steps.next();
        } else if (event === undefined) {
          try {
            Object.assign(state, { phase: "waiting" });
            await steps.publish(state);
            await ctx.approval(PUBLISH, {
              approver: decision.approver!,
              covers: [ops.change.merge],
              details: JSON.stringify({ change: { id: input.id, title: input.title, branch: opened.branch }, facts }),
              links: [opened.url, ...(input.page === undefined ? [] : [input.page])],
            });
            Object.assign(state, { phase: "merging" });
            await steps.publish(state);
            const merged = await ctx.sanoma.change.merge(merge);
            if (merged.outcome === "merged") event = { kind: "merged", sha: merged.sha ?? opened.head };
            else if (merged.outcome === "closed") event = { kind: "closed" };
            else if (merged.outcome === "moved") event = { kind: "commits" };
            else {
              Object.assign(state, { phase: "blocked", blocked: merged.reason ?? "the host refuses the merge" });
              await steps.publish(state);
              event = await steps.next();
            }
          } catch (err) {
            // A withdrawal is an event: the run reads it. A rejection of Publish closes the change.
            const code = errorCode(err);
            if (code === "approval_withdrawn") event = await steps.next();
            else if (code === "approval_rejected") {
              event = { kind: "close", by: ((err as SanomaError).data.by as { id: string }).id };
            } else throw err;
          }
        }
        if (event.kind === "merged") {
          Object.assign(state, { phase: "deploying" });
          await steps.publish(state);
          const deploy = await steps.deploy(event.sha);
          const verified = await steps.verify(deploy);
          await steps.closeDraft(input.id);
          const at = await ctx.now();
          const done = { sha: event.sha, at, deploy, ...(verified && { verified }) };
          Object.assign(state, { phase: "merged", merged: done });
          await steps.publish(state);
          report = {
            outcome: "merged",
            head: opened.head,
            pullRequest,
            sha: event.sha,
            deploy,
            ...(verified && { verified }),
          };
        } else if (event.kind === "close") {
          await ctx.sanoma.change.close({ id: input.id, number: opened.number });
          Object.assign(state, { phase: "closed", closedBy: event.by });
          await steps.publish(state);
          report = { outcome: "closed", head: opened.head, pullRequest };
        } else if (event.kind === "closed") {
          Object.assign(state, { phase: "closed" });
          await steps.publish(state);
          report = { outcome: "closed", head: opened.head, pullRequest };
        }
      }
      return report;
    },
  });
}
