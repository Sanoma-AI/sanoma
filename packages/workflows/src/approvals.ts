import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { type ApprovalRequest, type ApprovalResult, type ApprovalState, Approver, Principal } from "./define.ts";
import { RejectedError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import { warn } from "./log.ts";
import type { Run } from "./run.ts";

// The wire contract between a run waiting on approvals and whoever decides them. The client
// imports this file and never the worker's.

/** The DBOS event a run publishes its approvals on, as `ApprovalState[]`. */
export const APPROVALS_EVENT = "approvals";
/** The `recv` topic a decision on an approval is sent to. */
export const topicOf = (approvalId: string) => approvalId;
/** The DBOS event an approval's decision is published on, as its decided `ApprovalState`, once made. */
export const decisionEventOf = (approvalId: string) => `approval:${approvalId}`;

/** A decision, as sent to a run. */
export const ApprovalMessage = z.object({
  decision: z.enum(["approve", "reject"]),
  by: Principal,
  note: z.string().optional(),
});
export type ApprovalMessage = z.infer<typeof ApprovalMessage>;

export const statusOf = (decision: ApprovalMessage["decision"]) => (decision === "approve" ? "approved" : "rejected");

/**
 * True when `by` may decide the approval: `by.id` is the approver, or `by.groups` holds the
 * approver group. Pure: everything it reads is already recorded.
 */
export function mayDecide(approval: Pick<ApprovalState, "approver">, by: Principal): boolean {
  const { approver } = approval;
  return typeof approver === "string" ? approver === by.id : (by.groups?.includes(approver.group) ?? false);
}

/** Who may decide, as text: the person's id, or "group <name>". */
export const approverLabel = (approver: Approver) =>
  typeof approver === "string" ? approver : `group ${approver.group}`;

/** Why `by` may not decide the approval, naming who may. */
export const notApprover = (approval: Pick<ApprovalState, "approver">, by: Principal) =>
  typeof approval.approver === "string"
    ? `${by.id} is not the approver; ${approval.approver} is`
    : `${by.id} is not in group ${approval.approver.group}`;

/** The sender's id, from a message that may not be a valid decision. */
function senderOf(raw: unknown): string | undefined {
  const by = typeof raw === "object" && raw !== null ? (raw as { by?: unknown }).by : undefined;
  const id = typeof by === "object" && by !== null ? (by as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id : undefined;
}

const Covers = z.array(z.object({ id: z.string() }).transform((op) => op.id)).optional();

/** A policy's hold: the call held, and the other operations (by id) the policy said the approval covers. */
export interface HeldCall {
  op: string;
  input: unknown;
  covers?: string[];
}

/**
 * Waits, durably, for a decision from someone who may make it. Throws `RejectedError` on a
 * rejection. Without `held`, the workflow asked (`ctx.approval`); with it, the policy did.
 */
export async function awaitApproval(
  run: Run,
  title: string,
  req: ApprovalRequest,
  held?: HeldCall,
): Promise<ApprovalResult> {
  const approver = Approver.safeParse(req?.approver);
  if (!approver.success) throw new Error(`ctx.approval("${title}") needs an approver: a name, or { group: "name" }`);
  const named = Covers.safeParse(req.covers);
  if (!named.success) throw new Error(`ctx.approval("${title}"): covers must be a list of operations`);
  const covers = held ? [...new Set([held.op, ...(held.covers ?? [])])] : (named.data ?? []);

  const all = run.approvals;
  const state: ApprovalState = {
    id: `approval-${all.length + 1}`,
    title,
    approver: approver.data,
    ...(req.links === undefined ? {} : { links: req.links }),
    ...(req.details === undefined ? {} : { details: req.details }),
    requestedBy: held ? "policy" : "workflow",
    covers,
    ...(held ? { op: held.op, input: held.input } : {}),
    status: "pending",
    requestedAt: 0,
    refused: [],
  };
  all.push(state);
  state.requestedAt = await DBOS.now();
  await DBOS.setEvent(APPROVALS_EVENT, all);
  await write(
    run,
    entry(
      run,
      {
        type: "approval.requested",
        approval: state.id,
        title,
        approver: state.approver,
        requestedBy: state.requestedBy,
        covers,
        ...(held ? { op: held.op } : {}),
      },
      { key: state.id, at: state.requestedAt },
    ),
  );
  for (;;) {
    const raw = await DBOS.recv<unknown>(topicOf(state.id), { timeoutSeconds: 24 * 60 * 60 });
    if (raw === null || raw === undefined) {
      warn(`run ${run.id}: approval ${state.id} ("${title}") is still waiting for ${approverLabel(state.approver)}`);
      continue;
    }
    const at = await DBOS.now();
    const parsed = ApprovalMessage.safeParse(raw);
    const msg = parsed.success ? parsed.data : undefined;
    if (!msg || !mayDecide(state, msg.by)) {
      const by = msg?.by.id ?? senderOf(raw);
      const reason = msg ? notApprover(state, msg.by) : "not a valid decision message";
      state.refused.push(by === undefined ? { at, reason } : { by, at, reason });
      await DBOS.setEvent(APPROVALS_EVENT, all);
      await write(
        run,
        entry(
          run,
          { type: "approval.refused", approval: state.id, ...(by === undefined ? {} : { by }), reason },
          { key: `${state.id}:refused:${state.refused.length}`, at },
        ),
      );
      continue;
    }
    Object.assign(state, { status: statusOf(msg.decision), decidedBy: msg.by.id, decidedAt: at, note: msg.note });
    // The list first, so whoever sees the decision event also sees the list with it.
    await DBOS.setEvent(APPROVALS_EVENT, all);
    await DBOS.setEvent(decisionEventOf(state.id), state);
    await write(
      run,
      entry(
        run,
        { type: "approval.decided", approval: state.id, decision: msg.decision, by: msg.by.id, note: msg.note },
        { key: state.id, at },
      ),
    );
    if (msg.decision === "reject") throw new RejectedError(title, msg.by, msg.note, state.id);
    return { approvedBy: msg.by.id, at, note: msg.note };
  }
}
