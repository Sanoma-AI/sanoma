import { useState, type ReactNode } from "react";
import type { ApprovalState, Decision, Effect } from "@sanoma/workflows";
import type { DecideRequest } from "../src/api.ts";
import { ago, api, ApiError, errorText, fullTime, runHref } from "./lib.ts";

/** One color per effect, the same everywhere (see style.css). */
export function EffectBadge({ effect }: { effect: Effect }) {
  return <span className={`badge effect-${effect}`}>{effect}</span>;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  ENQUEUED: { label: "queued", tone: "waiting" },
  PENDING: { label: "running", tone: "running" },
  SUCCESS: { label: "finished", tone: "good" },
  ERROR: { label: "failed", tone: "bad" },
  CANCELLED: { label: "cancelled", tone: "muted" },
  MAX_RECOVERY_ATTEMPTS_EXCEEDED: { label: "gave up", tone: "bad" },
};

export function RunStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status.toLowerCase(), tone: "muted" };
  return (
    <span className={`badge tone-${s.tone}`} title={status}>
      {s.label}
    </span>
  );
}

const APPROVAL_TONE = { pending: "waiting", approved: "good", rejected: "bad" } as const;

export function ApprovalStatus({ status }: { status: ApprovalState["status"] }) {
  return <span className={`badge tone-${APPROVAL_TONE[status]}`}>{status}</span>;
}

export function DecisionBadge({ decision }: { decision: Decision }) {
  const tone = decision.kind === "allow" ? "good" : decision.kind === "deny" ? "bad" : "waiting";
  const title =
    decision.kind === "deny"
      ? decision.reason
      : decision.kind === "approve"
        ? `held for ${decision.approver}`
        : "allowed by policy";
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {decision.kind}
      {decision.kind === "approve" ? ` · ${decision.approver}` : ""}
    </span>
  );
}

export function When({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={fullTime(at)}>
      {ago(at)}
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

/** An approval with what it is for, who may decide, and the controls to decide when it is pending. */
export function ApprovalCard({
  runId,
  approval,
  onDecided,
  showRun = false,
}: {
  runId: string;
  approval: ApprovalState;
  onDecided: () => void;
  showRun?: boolean;
}) {
  return (
    <article className="card approval">
      <header className="row">
        <h3>{approval.title}</h3>
        <ApprovalStatus status={approval.status} />
      </header>
      <dl className="facts">
        <dt>Approver</dt>
        <dd>{approval.approver}</dd>
        <dt>Asked by</dt>
        <dd>
          {approval.requestedBy === "policy" ? (
            <>
              the policy, holding <code>{approval.op}</code>
            </>
          ) : (
            "the workflow"
          )}
        </dd>
        <dt>Asked</dt>
        <dd>
          <When at={approval.requestedAt} />
        </dd>
        {showRun && (
          <>
            <dt>Run</dt>
            <dd>
              <a href={runHref(runId)}>
                <code>{runId}</code>
              </a>
            </dd>
          </>
        )}
        {approval.decidedBy && (
          <>
            <dt>Decided</dt>
            <dd>
              {approval.status} by {approval.decidedBy}
              {approval.decidedAt ? (
                <>
                  , <When at={approval.decidedAt} />
                </>
              ) : null}
              {approval.note ? <q className="note">{approval.note}</q> : null}
            </dd>
          </>
        )}
      </dl>
      {approval.details && <p className="details">{approval.details}</p>}
      {approval.links?.length ? (
        <ul className="links">
          {approval.links.map((href) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noreferrer noopener">
                {href}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {approval.requestedBy === "policy" && approval.input !== undefined && (
        <Expandable label="The held call's input" value={approval.input} />
      )}
      {approval.refused.length > 0 && (
        <details className="expand">
          <summary>
            {approval.refused.length} message{approval.refused.length === 1 ? "" : "s"} ignored
          </summary>
          <ul className="refused">
            {approval.refused.map((r) => (
              <li key={r.at}>
                {r.by ?? "someone"}: {r.reason} (<When at={r.at} />)
              </li>
            ))}
          </ul>
        </details>
      )}
      {approval.status === "pending" && <DecisionControls runId={runId} approval={approval} onDecided={onDecided} />}
    </article>
  );
}

function DecisionControls({
  runId,
  approval,
  onDecided,
}: {
  runId: string;
  approval: ApprovalState;
  onDecided: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Enabled for anyone: the server decides who may, and says so.
  async function decide(decision: DecideRequest["decision"]) {
    setBusy(true);
    setError(undefined);
    try {
      const body: DecideRequest = note.trim() ? { decision, note: note.trim() } : { decision };
      await api(`/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        body,
      });
      setNote("");
      onDecided();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? `Only ${err.body.approver ?? approval.approver} can decide this`
          : errorText(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="decide" onSubmit={(e) => e.preventDefault()}>
      <input
        type="text"
        placeholder="Note (optional)"
        aria-label="Note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      <button type="button" className="approve" disabled={busy} onClick={() => void decide("approve")}>
        Approve
      </button>
      <button type="button" className="reject" disabled={busy} onClick={() => void decide("reject")}>
        Reject
      </button>
      {error && <p className="field-error">{error}</p>}
    </form>
  );
}
