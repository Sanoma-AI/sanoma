import type { ApprovalState, DriftStatus, PreviewAnswer, RecordedDecision, RunStatus } from "@sanoma-ai/workflows";
import type { ChangeState } from "@sanoma-ai/workflows/shared";
import type { CellChange } from "./grid-diff.ts";

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
  withdrawn: "off",
};

export const DECISION_TONE: Record<RecordedDecision["kind"], Tone> = { allow: "ok", deny: "bad", approve: "waiting" };

/** A preview's answer (the Permissions grid's cells): a hold waits on someone, the input decides `depends`. */
export const PREVIEW_TONE: Record<PreviewAnswer["answer"], Tone> = {
  allow: "off",
  hold: "waiting",
  deny: "bad",
  depends: "active",
};

/** A resource's verdict in a drift check: drifted wants a look, gone or unreadable is wrong, absent is not made (or bound) yet. */
export const DRIFT_TONE: Record<DriftStatus, Tone> = {
  clean: "ok",
  drifted: "waiting",
  gone: "bad",
  absent: "idle",
  error: "bad",
};

/** A Permissions grid diff's cell: let through more is ok, less is bad, to or from `depends` (or another approver) is active. */
export const GRID_CHANGE_TONE: Record<CellChange, Tone> = {
  same: "off",
  looser: "ok",
  added: "ok",
  tighter: "bad",
  removed: "bad",
  changed: "active",
};

/** Where a change is: under way is active, waiting on a review or an approval is waiting, merged ok, closed off, blocked bad. */
export const CHANGE_TONE: Record<ChangeState["phase"], Tone> = {
  opening: "active",
  planning: "active",
  checking: "active",
  reviewing: "waiting",
  waiting: "waiting",
  merging: "active",
  deploying: "active",
  merged: "ok",
  closed: "off",
  blocked: "bad",
};
