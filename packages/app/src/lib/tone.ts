import type { ApprovalState, DriftStatus, RecordedDecision, RunStatus } from "@sanoma/workflows";

// The tones live apart from the components, so code without React, such as the run graph's
// builder, can use them.

/** What a status means, one colour each (the --tone-* tokens in style.css). */
export type Tone = "ok" | "bad" | "waiting" | "active" | "idle" | "off";

export const RUN_TONE: Record<RunStatus, Tone> = {
  queued: "idle",
  running: "active",
  waiting: "waiting",
  finished: "ok",
  failed: "bad",
  cancelled: "off",
};

export const APPROVAL_TONE: Record<ApprovalState["status"], Tone> = {
  pending: "waiting",
  approved: "ok",
  rejected: "bad",
};

export const DECISION_TONE: Record<RecordedDecision["kind"], Tone> = { allow: "ok", deny: "bad", approve: "waiting" };

/** A resource's verdict in a drift check: drifted wants a look, gone or unreadable is wrong. */
export const DRIFT_TONE: Record<DriftStatus, Tone> = { clean: "ok", drifted: "waiting", gone: "bad", error: "bad" };
