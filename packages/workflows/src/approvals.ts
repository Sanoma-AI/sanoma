import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { type ApprovalRequest, type ApprovalResult, type ApprovalState, Principal } from "./define.ts";
import { RejectedError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import type { Run } from "./run.ts";

// The wire contract between a run waiting on approvals and whoever decides them. The client
// imports this file and never the worker's.

/** The DBOS event a run publishes its approvals on, as `ApprovalState[]`. */
export const APPROVALS_EVENT = "approvals";
/** The `recv` topic a decision on an approval is sent to. */
export const topicOf = (approvalId: string) => approvalId;
/** The DBOS event an approval's decision is published on, once made. */
export const decisionEventOf = (approvalId: string) => `approval:${approvalId}`;

/** A decision, as sent to a run. */
export const ApprovalMessage = z.object({
  decision: z.enum(["approve", "reject"]),
  by: Principal,
  note: z.string().optional(),
});
export type ApprovalMessage = z.infer<typeof ApprovalMessage>;

export const statusOf = (decision: ApprovalMessage["decision"]) => (decision === "approve" ? "approved" : "rejected");

/** True when `by` may decide the approval. Pure: everything it reads is already recorded. */
export function mayDecide(approval: Pick<ApprovalState, "approver">, by: Principal): boolean {
  return approval.approver === by.id;
}

/** The sender's id, from a message that may not be a valid decision. */
function senderOf(raw: unknown): string | undefined {
  const by = typeof raw === "object" && raw !== null ? (raw as { by?: unknown }).by : undefined;
  const id = typeof by === "object" && by !== null ? (by as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id : undefined;
}

const warn = (message: string) => console.warn(`sanoma: ${message}`);

/** Waits, durably, for the approver's decision. Throws `RejectedError` on a rejection. */
export async function awaitApproval(
  run: Run,
  title: string,
  req: ApprovalRequest,
  heldCall?: { op: string; input: unknown },
): Promise<ApprovalResult> {
  if (typeof req?.approver !== "string" || !req.approver.trim()) {
    throw new Error(`ctx.approval("${title}") needs an approver`);
  }
  const all = run.approvals;
  // Take the id and join the list before any await, so two approvals requested at once
  // (calls held by the policy inside Promise.all) get different ids and recv topics.
  const state: ApprovalState = {
    id: `approval-${all.length + 1}`,
    title,
    approver: req.approver,
    ...(req.links === undefined ? {} : { links: req.links }),
    ...(req.details === undefined ? {} : { details: req.details }),
    requestedBy: heldCall ? "policy" : "workflow",
    ...(heldCall ? { op: heldCall.op, input: heldCall.input } : {}),
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
        ...(heldCall ? { op: heldCall.op } : {}),
      },
      { key: state.id, at: state.requestedAt },
    ),
  );
  for (;;) {
    const raw = await DBOS.recv<unknown>(topicOf(state.id), { timeoutSeconds: 24 * 60 * 60 });
    if (raw === null || raw === undefined) {
      warn(`run ${run.id}: approval ${state.id} ("${title}") is still waiting for ${state.approver}`);
      continue;
    }
    const at = await DBOS.now();
    const parsed = ApprovalMessage.safeParse(raw);
    const msg = parsed.success ? parsed.data : undefined;
    if (!msg || !mayDecide(state, msg.by)) {
      const by = msg?.by.id ?? senderOf(raw);
      const reason = msg ? `${msg.by.id} is not the approver` : "not a valid decision message";
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
    await DBOS.setEvent(APPROVALS_EVENT, all);
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
