import type { Approver, PreviewAnswer } from "@sanoma-ai/workflows";
import type { OpEntry, WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { WORKFLOW_ACTION } from "@sanoma-ai/workflows/shared";
import type { PreviewQuery } from "../api.ts";

// The run form's "will ask" line: what the policy would answer the person for a workflow's start
// and every operation it may call, before the run starts (`previewFn`). The Permissions grid
// (`gridOf`) asks the same for each group, a row per request.

/** What to ask ahead of a run of `workflow`: its start, then each operation it may call, with its effect, in the run (`inRun`). */
export function previewRequests(workflow: WorkflowEntry, ops: ReadonlyMap<string, OpEntry>): PreviewQuery {
  return [
    { action: { id: `${WORKFLOW_ACTION}${workflow.name}` } },
    ...workflow.ops.map((id) => {
      const effect = ops.get(id)?.effect;
      return { action: effect === undefined ? { id } : { id, effect }, inRun: true };
    }),
  ];
}

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/** The action as the line names it: the start, or the operation's id. */
const named = (id: string) => (id.startsWith(WORKFLOW_ACTION) ? "the start" : id);

/** An approver as the line names it: the person's id, or the group's name. */
const asked = (approver: Approver) => (typeof approver === "string" ? approver : approver.group);

/**
 * What the policy will do ahead of the run, in one line: nothing when it allows everything;
 * "Will ask finance before the start" for each approver it holds for; "<rule> refuses <op>: <its
 * reason>" for a deny; and "<rule> may hold <op>, depending on the input" when the input decides.
 */
export function willAsk(requests: PreviewQuery, answers: readonly PreviewAnswer[]): string | undefined {
  // By approver, a person and a group of one name apart: each named as the line names it.
  const holds = new Map<string, { who: string; actions: string[] }>();
  const others: string[] = [];
  answers.forEach((a, i) => {
    const action = named(requests[i]!.action.id);
    if (a.answer === "allow") return;
    const rule = a.rule ? (a.rule.title ?? a.rule.id) : "The policy";
    if (a.answer === "hold") {
      // A hold always names its approver (`cedarPolicy`).
      const key = JSON.stringify(a.approver);
      const hold = holds.get(key) ?? { who: asked(a.approver!), actions: [] };
      hold.actions.push(action);
      holds.set(key, hold);
    } else if (a.answer === "deny") {
      others.push(`${rule} refuses ${action}${a.rule?.reason ? `: ${a.rule.reason}` : ""}`);
    } else {
      others.push(`${rule} may hold ${action}, depending on the input`);
    }
  });
  const lines = [
    ...[...holds.values()].map(({ who, actions }) => `Will ask ${who} before ${AND.format(actions)}`),
    ...others,
  ];
  return lines.length ? `${lines.join(". ")}.` : undefined;
}
