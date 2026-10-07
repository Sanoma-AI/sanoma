import type { ApprovalState } from "@sanoma/workflows";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { approverName, type DecideRequest, errorBodyOf, unwrap } from "../api.ts";
import { decideFn } from "../functions.ts";
import { ApprovalStatusBadge, Expandable, When } from "./common.tsx";

/** An approval: what it is for, who may decide, and the controls to decide while it is pending. */
export function ApprovalCard({
  runId,
  approval,
  showRun = false,
}: {
  runId: string;
  approval: ApprovalState;
  showRun?: boolean;
}) {
  return (
    <article className="card approval">
      <header className="row">
        <h3>{approval.title}</h3>
        <ApprovalStatusBadge status={approval.status} />
      </header>
      <dl className="facts">
        <dt>Approver</dt>
        <dd>{approverName(approval.approver)}</dd>
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
              <Link to="/runs/$id" params={{ id: runId }}>
                <code>{runId}</code>
              </Link>
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
            {approval.refused.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                {r.by ?? "someone"}: {r.reason} (<When at={r.at} />)
              </li>
            ))}
          </ul>
        </details>
      )}
      {approval.status === "pending" && <DecisionControls runId={runId} approval={approval} />}
    </article>
  );
}

/** Approve or Reject with an optional note. Enabled for anyone: the server says who may decide. */
function DecisionControls({ runId, approval }: { runId: string; approval: ApprovalState }) {
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const send = useServerFn(decideFn);
  const mutation = useMutation({
    mutationFn: async (decision: DecideRequest["decision"]) =>
      unwrap(
        await send({
          data: { runId, approvalId: approval.id, decision, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    onSuccess: async () => {
      setNote("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });
  const body = mutation.error ? errorBodyOf(mutation.error) : undefined;
  const error =
    body?.code === "not_approver"
      ? `Only ${approverName(body.approver ?? approval.approver)} can decide this`
      : (body?.error ?? mutation.error?.message);

  return (
    <form className="decide" onSubmit={(e) => e.preventDefault()}>
      <input
        type="text"
        placeholder="Note (optional)"
        aria-label="Note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={mutation.isPending}
      />
      <button
        type="button"
        className="approve"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate("approve")}
      >
        Approve
      </button>
      <button type="button" className="reject" disabled={mutation.isPending} onClick={() => mutation.mutate("reject")}>
        Reject
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
