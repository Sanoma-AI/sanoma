import { isDeepStrictEqual } from "node:util";
import type { Approver } from "./define.ts";
import type { DriftReport, DriftResult } from "./drift.ts";
import type { LedgerRecord } from "./ledger.ts";
import type { RecordedDecision } from "./policy.ts";
import type { Expectation } from "./scenario.ts";
import { approverLabel } from "./shared.ts";

/*
 * What the generic `Then` steps check against a run's ledger records: pure, and internal to
 * `scenario.ts`, whose steps call it (its tests do too).
 */

/** A call in a run: an `op.called` record. */
export type CallRecord = Extract<LedgerRecord, { type: "op.called" }>;
type Request = Extract<LedgerRecord, { type: "approval.requested" }>;

export const isCall = (r: LedgerRecord): r is CallRecord => r.type === "op.called";
const isRequest = (r: LedgerRecord): r is Request => r.type === "approval.requested";

/** True when `actual` has every key `expected` has, with an equal value, at every depth. */
export function contains(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    return isDeepStrictEqual(actual, expected);
  }
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([k, v]) => contains((actual as Record<string, unknown>)[k], v));
}

/** The inputs of the calls, as JSON, for a detail. */
const inputs = (list: CallRecord[]) => list.map((r) => JSON.stringify(r.input)).join(", ");

/** A policy's decision as words: `allowed`, `denied`, `held for finance`. */
const words = (d: RecordedDecision) =>
  d.kind === "allow" ? "allowed" : d.kind === "deny" ? "denied" : `held for ${approverLabel(d.approver)}`;

/** What the policy decided for the calls, each decision once: `allowed and held for finance`. */
const decisions = (calls: CallRecord[]) => [...new Set(calls.map((r) => words(r.decision)))].join(" and ");

/** True when `who` names the approver: a person by id, or a group by its name. */
const isApprover = (approver: Approver, who: string) =>
  typeof approver === "string" ? approver === who : approver.group === who;

/** How a drift report found a resource, as words: `clean`, `gone`, `drifted in has_wiki, topics`. */
const found = (r: DriftResult) =>
  r.status === "drifted" ? `drifted in ${r.fields.map((f) => f.path).join(", ")}` : r.status;

/** An expectation of the generic steps, without its step's text. */
export type CoreExpectation = Unstepped<Exclude<Expectation, { custom: true }>>;
type Unstepped<T> = T extends unknown ? Omit<T, "step"> : never;

/**
 * Why a drift expectation fails against the report a finished drift run returned as its
 * output, or undefined when the report found the resource as expected.
 */
function driftDetail(
  e: Extract<CoreExpectation, { declared: string }>,
  end: Extract<LedgerRecord, { type: "run.finished" }>,
): string | undefined {
  const report = end.output as Partial<DriftReport> | null | undefined;
  if (!Array.isArray(report?.resources)) return "the run's output is not a drift report";
  const resource = report.resources.find((r) => r.id === e.declared);
  if (!resource) {
    return `no resource ${e.declared} in the report; it has ${report.resources.map((r) => r.id).join(", ") || "none"}`;
  }
  if (resource.status === "error") return `${e.declared} could not be read: ${resource.error}`;
  const ok =
    resource.status === e.status && (e.status !== "drifted" || resource.fields.some((f) => f.path === e.field));
  if (ok) return undefined;
  return `${e.declared} is ${found(resource)}, not ${e.status === "drifted" ? `drifted in ${e.field}` : e.status}`;
}

/**
 * Why an expectation of the generic steps does not hold against a run's ledger records, or
 * undefined when it does. A call is an `op.called` record without an `error`; one with an error
 * (a policy denial, a rejected approval, a vendor's final failure) was attempted, not made. An
 * operation `was denied` when the policy's decision on some call to it is `deny`, and `was held
 * for` an approver when an approval for that approver holds it: one the policy asked for on its
 * call, or one that `covers` it. A drift expectation reads the report a finished drift run
 * returned.
 */
export function detailOf(e: CoreExpectation, records: readonly LedgerRecord[]): string | undefined {
  const end = records.find((r) => r.type === "run.finished" || r.type === "run.failed");
  const calls = records.filter(isCall);
  const callsTo = (op: string) => calls.filter((r) => r.op === op);
  if ("decision" in e) {
    const tries = callsTo(e.op);
    if (e.decision === "denied") {
      if (tries.some((r) => r.decision.kind === "deny")) return undefined;
      return tries.length ? `${e.op} was ${decisions(tries)}, not denied` : `no call to ${e.op}`;
    }
    const holds = records.filter(isRequest).filter((r) => r.op === e.op || r.covers.includes(e.op));
    if (holds.some((r) => isApprover(r.approver, e.approver))) return undefined;
    return holds.length
      ? `${e.op} was held for ${[...new Set(holds.map((r) => approverLabel(r.approver)))].join(" and ")}, not ${e.approver}`
      : tries.length
        ? `${e.op} was ${decisions(tries)}, not held`
        : `no call to ${e.op}`;
  }
  if ("called" in e) {
    const tries = callsTo(e.op);
    const made = tries.filter((r) => !r.error);
    const matching = made.filter((r) => e.input === undefined || contains(r.input, e.input));
    if (matching.length > 0 === e.called) return undefined;
    if (!e.called) return `${e.op} was called with ${inputs(matching)}`;
    const what = e.input === undefined ? e.op : `${e.op} with ${JSON.stringify(e.input)}`;
    const tried = tries.flatMap(({ error }) => (error ? [`${error.code ?? error.name}: ${error.message}`] : []));
    return [
      `no call to ${what}`,
      ...(made.length ? [`its calls had ${inputs(made)}`] : []),
      ...(tried.length ? [`attempted: ${tried.join(", ")}`] : []),
    ].join("; ");
  }
  // The rest read how the run ended.
  if (!end) return "run not ended";
  if ("outcome" in e && e.outcome === "failed") {
    if (end.type !== "run.failed") return "the run finished";
    if (e.code === undefined || end.error.code === e.code) return undefined;
    return `the run failed with ${end.error.code ?? "no code"}: ${end.error.message}`;
  }
  // A finished run: what `the run succeeds` expects, and what a drift expectation reads its report from.
  if (end.type === "run.failed") return `the run failed: ${end.error.message}`;
  return "declared" in e ? driftDetail(e, end) : undefined;
}
