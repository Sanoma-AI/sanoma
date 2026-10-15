import type { LedgerRecord } from "@sanoma-ai/workflows";
import type { GraphNode } from "../graph/types.ts";

// Between a run's graph and its ledger: the records a node stands for, and the node a record is drawn as.

/**
 * The ledger records a run graph's node stands for, in the ledger's order: the record it was
 * drawn from (`state.recordId`), and the records of the approvals that belong to it. An
 * operation's are those the policy asked for to hold its call (their `opSeq` is the call's
 * `seq`), asked, decided or ignored; an approval's are its own. None for a node with no record:
 * an outline's, or one a run has not reached.
 */
export function recordsFor(node: GraphNode, ledger: readonly LedgerRecord[]): LedgerRecord[] {
  const recordId = "state" in node ? node.state?.recordId : undefined;
  const own = recordId === undefined ? undefined : ledger.find((record) => record.id === recordId);
  if (!own) return [];
  const approvals = new Set<string>();
  // The call whose holds belong to the node: its own, or, for a held call not recorded yet (drawn
  // from its approval's request), the one the request holds.
  let seq: number | undefined;
  if (own.type === "op.called") seq = own.seq;
  if (own.type === "approval.requested") {
    approvals.add(own.approval);
    seq = own.opSeq;
  }
  if (seq !== undefined) {
    for (const record of ledger) {
      if (record.type === "approval.requested" && record.opSeq === seq) approvals.add(record.approval);
    }
  }
  return ledger.filter((record) => {
    const approval = approvalOf(record);
    return record === own || (approval !== undefined && approvals.has(approval));
  });
}

/**
 * Each record a node of the graph stands for (`recordsFor`), by id, with the node's id: where a
 * ledger row's "Show in graph" leads. A record no node stands for (a scenario's seeding) has none.
 */
export function nodesByRecord(nodes: readonly GraphNode[], ledger: readonly LedgerRecord[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const node of nodes) {
    for (const record of recordsFor(node, ledger)) found.set(record.id, node.id);
  }
  return found;
}

/** The approval an approval's record is about. */
const approvalOf = (record: LedgerRecord) =>
  record.type === "approval.requested" || record.type === "approval.decided" || record.type === "approval.refused"
    ? record.approval
    : undefined;
