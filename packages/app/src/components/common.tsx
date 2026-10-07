import type { ApprovalState, Decision, Effect, RunStatus } from "@sanoma/workflows";
import { useEffect, useState, type ReactNode } from "react";
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
export function DecisionBadge({ decision }: { decision: Decision }) {
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

/**
 * A time, relative to now in the browser. The server renders the ISO time, so the page
 * hydrates the same markup whatever the browser's clock and time zone.
 */
export function When({ at }: { at: number }) {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const iso = new Date(at).toISOString();
  return (
    <time dateTime={iso} title={now === undefined ? iso : new Date(at).toLocaleString()}>
      {now === undefined ? iso.replace("T", " ").slice(0, 19) : ago(at, now)}
    </time>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2) ?? "undefined"}</pre>;
}

/** JSON behind a disclosure, for inputs and outputs that are usually too long to show inline. */
export function Expandable({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="expand">
      <summary>{label}</summary>
      <Json value={value} />
    </details>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "bad"; children: ReactNode }) {
  return <p className={`notice tone-${tone}`}>{children}</p>;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
