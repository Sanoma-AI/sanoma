import type { ApprovalState, LedgerGroup, LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { OutlineNode, Span } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { utcText } from "../lib/time.ts";
import { APPROVAL_TONE, RUN_TONE, type Tone } from "../lib/tone.ts";
import { type Ends, outlineGraph } from "./outline-graph.ts";
import type { Graph, Step } from "./types.ts";

type OpStep = Extract<Step, { kind: "op" }>;
type AllStep = Extract<Step, { kind: "all" }>;

/**
 * A run's graph, built from its ledger (`records`, in `seq` order) and its approvals as the run
 * tells them (`run.approvals`): where it started, each operation call, sleep and approval the
 * workflow asked for, and how it ended. The records of one `ctx.all` (one `group.id`) are its
 * lanes, one per member (`group.index`); while the run is in the group, the members it has
 * recorded nothing for yet are pending lanes. `now` is when the ledger was read, which a sleep's
 * end is compared with. Given the workflow's `outline`, each step's node has the `spans` of the
 * outline's steps it may be (see `spansOf`).
 */
export function runGraph(
  records: readonly LedgerRecord[],
  run: RunSummary,
  now: number,
  outline: readonly OutlineNode[] = [],
): Graph {
  const ended = isEnded(run.status);
  const where = spansOf(outline);
  const inSource = (...keys: string[]) => {
    const spans = keys.map((key) => where.get(key)).find(Boolean);
    return spans ? { spans } : {};
  };
  const approvals = new Map(run.approvals.map((a) => [a.id, a]));
  const steps: Step[] = [];
  /** Op steps by seq: a policy's approval finds the call it holds by `opSeq`. */
  const ops = new Map<number, OpStep>();
  const groups = new Map<string, { step: AllStep; size: number }>();
  let start: Ends["start"] = { tone: "ok" };
  let end: Ends["end"] | undefined;

  /** Adds the step after the others, or to its member's lane in its `ctx.all`. */
  const place = (step: Step, group: LedgerGroup | undefined) => {
    if (!group) {
      steps.push(step);
      return;
    }
    let fan = groups.get(group.id);
    if (!fan) {
      fan = { step: { kind: "all", branches: [] }, size: group.size };
      groups.set(group.id, fan);
      steps.push(fan.step);
    }
    (fan.step.branches[group.index] ??= []).push(step);
  };

  for (const record of records) {
    switch (record.type) {
      case "run.started":
        start = { tone: "ok", recordId: record.id };
        break;
      case "op.called": {
        const failed = record.error !== undefined || record.decision.kind === "deny";
        const step: OpStep = {
          kind: "op",
          id: record.op,
          key: `op:${record.seq}`,
          ...inSource(`op:${record.op}`),
          state: {
            tone: failed ? "bad" : "ok",
            recordId: record.id,
            decision: record.decision.kind,
            durationMs: record.durationMs,
            ...(record.error?.code && { errorCode: record.error.code }),
          },
        };
        ops.set(record.seq, step);
        place(step, record.group);
        break;
      }
      case "approval.requested": {
        const approval = approvals.get(record.approval);
        const status = approval?.status ?? "pending";
        if (record.op !== undefined && record.opSeq !== undefined) {
          // The policy's: it belongs to the call it holds, whose op.called, numbered before the
          // approval, is written only once the call has run.
          const held = ops.get(record.opSeq);
          if (held) {
            if (approval) held.state = { ...held.state!, approval };
          } else {
            const step: OpStep = {
              kind: "op",
              id: record.op,
              key: `op:${record.opSeq}`,
              ...inSource(`op:${record.op}`),
              state: { tone: heldTone(status, ended), recordId: record.id, ...(approval && { approval }) },
            };
            ops.set(record.opSeq, step);
            place(step, record.group);
          }
        } else {
          const tone = ended && status === "pending" ? "off" : APPROVAL_TONE[status];
          place(
            {
              kind: "approval",
              title: record.title,
              key: `approval:${record.approval}`,
              ...inSource(`approval:${record.title}`, "approval"),
              state: { tone, recordId: record.id, ...(approval && { approval }) },
            },
            record.group,
          );
        }
        break;
      }
      case "sleep.started": {
        // Asleep while it is the run's last record and its time has not come.
        const asleep = !ended && record === records.at(-1) && record.until > now;
        place(
          {
            kind: "sleep",
            key: `sleep:${record.seq}`,
            ...inSource("sleep"),
            label: `sleep until ${utcText(record.until)}`,
            state: { tone: asleep ? "waiting" : "ok", recordId: record.id },
          },
          record.group,
        );
        break;
      }
      case "run.finished":
      case "run.failed": {
        const finished = record.type === "run.finished";
        end = {
          label: finished ? "finished" : "failed",
          state: { tone: finished ? "ok" : "bad", recordId: record.id },
        };
        break;
      }
    }
  }

  // Members run in order, so those after the last one recorded have not run. While the run is
  // in the group (it is the last thing recorded), they are pending; once it has gone on, or
  // ended, they never ran and have no lane. A member that wrote nothing has none either.
  for (const [id, { step, size }] of groups) {
    if (!ended && step === steps.at(-1)) {
      for (let index = step.branches.length; index < size; index++) {
        step.branches[index] = [{ kind: "pending", key: `pending:${id}:${index}` }];
      }
    }
    step.branches = step.branches.filter(Boolean);
  }

  // Not ended: a placeholder, moving once a sleep that was the last record is over, since the run
  // is then on to its next call. Ended without a record (cancelled, say): the run's status.
  const last = records.at(-1);
  const woke = last?.type === "sleep.started" && last.until <= now;
  end ??= ended
    ? { label: run.status, state: { tone: RUN_TONE[run.status] } }
    : { label: "pending", pending: true, state: { tone: woke ? "active" : "off" } };
  return outlineGraph(steps, { start, end });
}

/**
 * Where the outline makes each kind of call, by what a ledger record names: `op:<id>` for an
 * operation's calls, `approval:<title>` for the approvals with that title and `approval` for
 * all of them, `sleep` for the sleeps. A record is matched by what it is, not where it was
 * called from (the ledger does not say), so a step may be any of several places.
 */
function spansOf(outline: readonly OutlineNode[]): Map<string, Span[]> {
  const spans = new Map<string, Span[]>();
  const add = (key: string, span: Span) => spans.set(key, [...(spans.get(key) ?? []), span]);
  const walk = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      switch (node.kind) {
        case "op":
          add(`op:${node.id}`, node.span);
          break;
        case "approval":
          add("approval", node.span);
          if (node.title !== undefined) add(`approval:${node.title}`, node.span);
          break;
        case "sleep":
          add("sleep", node.span);
          break;
        case "all":
          node.branches.forEach(walk);
          break;
        case "branch":
          node.cases.forEach(walk);
          break;
        case "each":
        case "repeat":
          walk(node.body);
          break;
      }
    }
  };
  walk(outline);
  return spans;
}

/** A held call not recorded yet: waiting on its approval, or running once approved. */
function heldTone(status: ApprovalState["status"], ended: boolean): Tone {
  if (status === "rejected") return "bad";
  if (ended) return "off";
  return status === "approved" ? "active" : "waiting";
}
