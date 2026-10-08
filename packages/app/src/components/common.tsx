import type { ApprovalState, Effect, RecordedDecision, RunStatus } from "@sanoma/workflows";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { approverName } from "../api.ts";

// Small presentational pieces shared by the screens. Plain markup and the classes in
// style.css, so a component kit can replace them one by one.

/** One colour per effect, the same everywhere. */
export function EffectBadge({ effect }: { effect: Effect }) {
  return <span className={`badge effect-${effect}`}>{effect}</span>;
}

const STATUS_TONE: Record<RunStatus, string> = {
  queued: "waiting",
  running: "running",
  waiting: "waiting",
  finished: "good",
  failed: "bad",
  cancelled: "muted",
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <span className={`badge tone-${STATUS_TONE[status]}`}>{status}</span>;
}

const APPROVAL_TONE = { pending: "waiting", approved: "good", rejected: "bad" } as const;

export function ApprovalStatusBadge({ status }: { status: ApprovalState["status"] }) {
  return <span className={`badge tone-${APPROVAL_TONE[status]}`}>{status}</span>;
}

/** The policy's decision on an operation call. */
export function DecisionBadge({ decision }: { decision: RecordedDecision }) {
  const tone = decision.kind === "allow" ? "good" : decision.kind === "deny" ? "bad" : "waiting";
  const approver = decision.kind === "approve" ? approverName(decision.approver) : undefined;
  const title =
    decision.kind === "deny" ? decision.reason : approver ? `held for ${approver}` : "allowed by the policy";
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {decision.kind}
      {approver ? ` · ${approver}` : ""}
    </span>
  );
}

function ago(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return new Date(ms).toLocaleDateString();
}

// One clock for every `When` on the page, ticking every 15 s while any is shown.
let now: number | undefined;
const watchers = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;

function watchClock(onTick: () => void) {
  watchers.add(onTick);
  if (!ticker) {
    // A clock read while nothing watched it may be old: catch up now.
    now = Date.now();
    ticker = setInterval(() => {
      now = Date.now();
      for (const watcher of watchers) watcher();
    }, 15_000);
  }
  return () => {
    watchers.delete(onTick);
    if (!watchers.size) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

const readClock = () => (now ??= Date.now());
/** The server, and the browser while it hydrates, know no time: they render the ISO time. */
const noClock = () => undefined;

/**
 * A time, relative to now in the browser. The server renders the ISO time, so the page
 * hydrates the same markup whatever the browser's clock and time zone.
 */
export function When({ at }: { at: number }) {
  const clock = useSyncExternalStore(watchClock, readClock, noClock);
  const iso = new Date(at).toISOString();
  return (
    <time dateTime={iso} title={clock === undefined ? iso : new Date(at).toLocaleString()}>
      {clock === undefined ? iso.replace("T", " ").slice(0, 19) : ago(at, clock)}
    </time>
  );
}

export function Json({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? "undefined", [value]);
  return <pre className="json">{text}</pre>;
}

/** JSON behind a disclosure, for inputs and outputs that are usually too long to show inline. Written out only once opened. */
export function Expandable({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="expand" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label}</summary>
      {open && <Json value={value} />}
    </details>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "bad"; children: ReactNode }) {
  return <p className={`notice tone-${tone}`}>{children}</p>;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
