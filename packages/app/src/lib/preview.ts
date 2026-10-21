import type { Approver } from "@sanoma-ai/workflows";
import type { OpEntry, WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { flatten, WORKFLOW_ACTION } from "@sanoma-ai/workflows/shared";
import type { PreviewQuery, PreviewResult } from "../api.ts";

// The run form's "will ask" line: what the policy would answer the person for a workflow's start
// and every operation its outline may call, before the run starts (`previewFn`).

/**
 * What to ask ahead of a run of `workflow`: its start, then each operation its outline may call,
 * once, with its effect (an operation whose id is computed, each it may be).
 */
export function previewRequests(workflow: WorkflowEntry, ops: ReadonlyMap<string, OpEntry>): PreviewQuery {
  const nodes = "nodes" in workflow.outline ? flatten(workflow.outline.nodes) : [];
  const ids = new Set(nodes.flatMap((node) => (node.kind === "op" ? (node.ops ?? [node.id]) : [])));
  return [
    { action: { id: `${WORKFLOW_ACTION}${workflow.name}` } },
    ...[...ids].map((id) => {
      const effect = ops.get(id)?.effect;
      return { action: effect === undefined ? { id } : { id, effect } };
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
 * reason>" for a deny; "<rule> may hold <op>, depending on the input" when the input decides; and
 * "This policy cannot be asked ahead" when it cannot be (a `definePolicy` function).
 */
export function willAsk(requests: PreviewQuery, answers: readonly PreviewResult[]): string | undefined {
  if (answers.some(({ answer }) => answer === "custom")) return "This policy cannot be asked ahead.";
  // By approver, a person and a group of one name apart: each named as the line names it.
  const holds = new Map<string, { who: string; actions: string[] }>();
  const others: string[] = [];
  answers.forEach((a, i) => {
    const action = named(requests[i]!.action.id);
    if (a.answer === "custom" || a.answer === "allow") return;
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
