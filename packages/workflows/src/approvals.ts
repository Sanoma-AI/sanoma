import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import { type ApprovalRequest, type ApprovalResult, type ApprovalState, Principal } from "./define.ts";
import { RejectedError } from "./errors.ts";
import { entry, write } from "./ledger.ts";
import { warn } from "./log.ts";
import type { Placed } from "./call.ts";
import type { Run } from "./run.ts";
import { readPeople } from "./resources.ts";
import { approverLabel, OWN_CHANGE, refusalOf } from "./shared.ts";

// The wire contract between a run waiting on approvals and whoever decides them. The client
// imports this file and never the worker's.

/** The DBOS event a run publishes its approvals on, as `ApprovalState[]`. */
export const APPROVALS_EVENT = "approvals";
/** The `recv` topic a decision on an approval is sent to. */
export const topicOf = (approvalId: string) => approvalId;
/** The DBOS event an approval's decision is published on, as its decided `ApprovalState`, once made. */
export const decisionEventOf = (approvalId: string) => `approval:${approvalId}`;
/**
 * The idempotency key a decision message is sent with, so a retried send queues it once. DBOS
 * scopes the key per run, not per topic, so it names the approval too: one message id reused
 * for two approvals of a run would otherwise drop the second send.
 */
export const messageKeyOf = (approvalId: string, messageId: string) => `${approvalId}:${messageId}`;

/**
 * A decision, as sent to a run. `id` names the message, so whoever sent it can tell whether
 * the run decided with it or with another; `SanomaClient.decide` sets one.
 */
export const ApprovalMessage = z.object({
  id: z.string().optional(),
  decision: z.enum(["approve", "reject"]),
  by: Principal,
  note: z.string().optional(),
});
export type ApprovalMessage = z.infer<typeof ApprovalMessage>;

const statusOf = (decision: ApprovalMessage["decision"]) => (decision === "approve" ? "approved" : "rejected");

/** The sender's id, from a message that may not be a valid decision. */
function senderOf(raw: unknown): string | undefined {
  const by = typeof raw === "object" && raw !== null ? (raw as { by?: unknown }).by : undefined;
  const id = typeof by === "object" && by !== null ? (by as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/** An approval request as checked: who may decide it, and the operations it covers, by id. */
export interface CheckedApproval extends Omit<ApprovalRequest, "covers"> {
  covers: string[];
}

/**
 * A policy's hold: the call held (an operation, or `workflow:<name>` for a run's start), the
 * ledger `seq` its `op.called` record takes (a start has none), and the rules that held it.
 */
export interface HeldCall {
  op: string;
  seq?: number;
  input: unknown;
  reasons?: string[] | undefined;
}

/**
 * Waits, durably, for a decision from someone who may make it (`mayDecide`: the run's own actor
 * only while nobody else could). Throws `RejectedError` on a rejection. Without `held`, the workflow asked
 * (`ctx.approval`); with it, the policy did, and `place` is the held call's outline node and name
 * (none for a run's start, which is no call in the outline).
 */
export async function awaitApproval(
  run: Run,
  title: string,
  req: CheckedApproval,
  place: Placed | undefined,
  held?: HeldCall,
): Promise<ApprovalResult> {
  const { covers } = req;
  const all = run.approvals;
  const state: ApprovalState = {
    id: `approval-${all.length + 1}`,
    title,
    approver: req.approver,
    ...(req.links === undefined ? {} : { links: req.links }),
    ...(req.details === undefined ? {} : { details: req.details }),
    requestedBy: held ? "policy" : "workflow",
    covers,
    ...(held && { op: held.op, ...heldOf(held), input: held.input }),
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
        ...place,
        title,
        approver: state.approver,
        requestedBy: state.requestedBy,
        covers,
        ...(held && { op: held.op, ...heldOf(held) }),
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
    // The people matter only when the run's own actor decides (`refusalOf`): then they are read as
    // the data files declare them now, in a step, so a replay decides the same. While those files
    // have problems, someone else may be missing from them, so the starter is refused.
    const refusal = !msg
      ? null
      : msg.by.id === run.actor.id
        ? await DBOS.runStep(
            async () => {
              const { people, problems } = readPeople(run.state.root);
              return refusalOf(state, msg.by, run, people) ?? (problems.length ? OWN_CHANGE : null);
            },
            { name: `decider:${state.id}` },
          )
        : (refusalOf(state, msg.by, run, []) ?? null);
    if (!msg || refusal !== null) {
      const by = msg?.by.id ?? senderOf(raw);
      const reason = refusal ?? "not a valid decision message";
      state.refused.push({
        ...(by === undefined ? {} : { by }),
        ...(msg?.id === undefined ? {} : { id: msg.id }),
        at,
        reason,
      });
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
    // The run's own actor decides only when nobody else could, which the record says.
    const alone = msg.by.id === run.actor.id ? { alone: true as const } : {};
    Object.assign(state, {
      status: statusOf(msg.decision),
      decidedBy: msg.by.id,
      decidedAt: at,
      note: msg.note,
      decidedWith: msg.id,
      ...alone,
    });
    // The list first, then the ledger, then the decision event: whoever sees the event sees both.
    await DBOS.setEvent(APPROVALS_EVENT, all);
    await write(
      run,
      entry(
        run,
        {
          type: "approval.decided",
          approval: state.id,
          decision: msg.decision,
          by: msg.by.id,
          note: msg.note,
          ...alone,
        },
        { key: state.id, at },
      ),
    );
    await DBOS.setEvent(decisionEventOf(state.id), state);
    if (msg.decision === "reject") throw new RejectedError(title, msg.by, msg.note, state.id);
    return { approvedBy: msg.by.id, at, note: msg.note };
  }
}

/** What an approval and its request record keep of a hold besides the operation: its `seq` and rules, when it has them. */
const heldOf = ({ seq, reasons }: HeldCall) => ({
  ...(seq !== undefined && { opSeq: seq }),
  ...(reasons !== undefined && { reasons }),
});
