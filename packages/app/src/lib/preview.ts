import type { PreviewAnswer } from "@sanoma-ai/workflows";
import { WORKFLOW_ACTION } from "@sanoma-ai/workflows/shared";
import type { PreviewQuery } from "../api.ts";
import { approverName } from "./changes.ts";

// The run form's "will ask" line: what the policy would answer the person for a workflow's start
// and every operation it may call, before the run starts (`previewFn`), asked as `previewRequests`
// says (the runtime's, which the Permissions grid asks for each group).

export { previewRequests } from "@sanoma-ai/workflows/shared";

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/** The action as the line names it: the start, or the operation's id. */
const named = (id: string) => (id.startsWith(WORKFLOW_ACTION) ? "the start" : id);

/** An approver as the line names it: the person's id, or the group's name. */

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
      const hold = holds.get(key) ?? { who: approverName(a.approver!), actions: [] };
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
