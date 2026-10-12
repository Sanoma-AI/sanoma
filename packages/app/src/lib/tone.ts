import type { ApprovalState, DriftStatus, RecordedDecision, RunStatus } from "@sanoma/workflows";

// The tones live apart from the components, so code without React, such as the run graph's
// builder, can use them.

/** What a status means, one colour each (the --tone-* tokens in style.css). */
export type Tone = "ok" | "bad" | "waiting" | "active" | "idle" | "off";

/** A tone as a solid fill, readable against the page (3:1): status dots and the run strips' squares. */
export const TONE_FILL: Record<Tone, string> = {
  ok: "bg-tone-ok-foreground",
  bad: "bg-tone-bad-foreground",
  waiting: "bg-tone-waiting-foreground",
  active: "bg-tone-active-foreground",
  idle: "bg-tone-idle-foreground",
  off: "bg-tone-off-foreground",
};

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
