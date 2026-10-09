import type { ApprovalState, LedgerGroup, LedgerRecord, RunSummary } from "@sanoma/workflows";
import type { OutlineNode, Span } from "@sanoma/workflows/describe";
import { isEnded } from "@sanoma/workflows/shared";
import { utcText } from "../lib/time.ts";
import { APPROVAL_TONE, RUN_TONE, type Tone } from "../lib/tone.ts";
import { type Ends, outlineGraph } from "./outline-graph.ts";
import type { CallStep, Graph, GraphSource, Step } from "./types.ts";

type OpStep = Extract<Step, { kind: "op" }>;
type AllStep = Extract<Step, { kind: "all" }>;

/**
 * A run's graph, built from its ledger (`records`, in `seq` order) and its approvals as the run
 * tells them (`run.approvals`): where it started, each operation call, sleep and approval the
 * workflow asked for, and how it ended. The records of one `ctx.all` (one `group.id`) are its
 * lanes, one per member (`group.index`); while the run is in the group, the members it has
 * recorded nothing for yet are pending lanes. `now` is when the ledger was read, which a sleep's
 * end is compared with. Given the workflow's `outline`, each call's node has the `spans` of the
 * outline's calls it may be (see `whereIn`).
 */
export function runGraph(
  records: readonly LedgerRecord[],
  run: RunSummary,
  now: number,
  outline: readonly OutlineNode[] = [],
): Graph {
  const ended = isEnded(run.status);
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
  return outlineGraph(steps, { start, end }, whereIn(outline));
}

/** A page's graph, from what it is drawn from. */
export const graphOf = (source: GraphSource): Graph =>
  "ledger" in source ? runGraph(source.ledger, source.run, source.at, source.outline) : outlineGraph(source.outline);

type Call = Extract<OutlineNode, { kind: CallStep["kind"] }>;

/** The outline's calls, wherever they are in it. */
const calls = (nodes: readonly OutlineNode[]): Call[] =>
  nodes.flatMap((node) =>
    node.kind === "all"
      ? node.branches.flatMap(calls)
      : node.kind === "branch"
        ? node.cases.flatMap(calls)
        : node.kind === "each" || node.kind === "repeat"
          ? calls(node.body)
          : [node],
  );

/** The calls' spans, or none when there are no calls. */
const spansOf = (found: readonly Call[]) => (found.length ? found.map((call) => call.span) : undefined);

/**
 * Where a run's call is in the source: the spans of the outline's calls it may be. A record says
 * what was called, not where from, so a step may be any of several calls: an operation's, the
 * calls of that operation; an approval's, those with its title, or else every approval; a
 * sleep's, every sleep.
 */
function whereIn(outline: readonly OutlineNode[]): (step: CallStep) => Span[] | undefined {
  const all = calls(outline);
  const ofKind = <K extends Call["kind"]>(kind: K) =>
    all.filter((call): call is Extract<Call, { kind: K }> => call.kind === kind);
  return (step) => {
    switch (step.kind) {
      case "op":
        return spansOf(ofKind("op").filter((call) => call.id === step.id));
      case "approval": {
        const approvals = ofKind("approval");
        const titled = approvals.filter((call) => call.title === step.title);
        return spansOf(titled.length ? titled : approvals);
      }
      case "sleep":
        return spansOf(ofKind("sleep"));
    }
  };
}

/** A held call not recorded yet: waiting on its approval, or running once approved. */
function heldTone(status: ApprovalState["status"], ended: boolean): Tone {
  if (status === "rejected") return "bad";
  if (ended) return "off";
  return status === "approved" ? "active" : "waiting";
}
