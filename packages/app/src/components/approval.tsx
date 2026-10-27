import type { ApprovalState, RunStatus, RunSummary } from "@sanoma-ai/workflows";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "#/components/ui/field.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { approverLabel, CHANGE_WORKFLOW, isEnded, OWN_CHANGE } from "@sanoma-ai/workflows/shared";
import { type DecideRequest, errorBodyOf } from "../api.ts";
import { asApplyPlan } from "../lib/apply-plan.ts";
import { asChangeRef } from "../lib/changes.ts";
import { decideFn } from "../functions.ts";
import { configQuery, opsById, RUNS_KEY, runLink, runQuery } from "../queries.ts";
import { ApplyPlanView } from "./apply-plan.tsx";
import { ChangeGlance } from "./change-glance.tsx";
import {
  ALONE,
  DecisionNote,
  Disclosure,
  Expandable,
  Fact,
  Facts,
  ItemTime,
  LinkItem,
  Notice,
  OpName,
  plural,
  RequestedBy,
  When,
} from "./common.tsx";

type Decision = DecideRequest["decision"];

/** What the two decisions are called on their buttons and in the dialog: Approve and Reject, unless a page names them (a change's Publish). */
export interface Verbs {
  approve: string;
  reject: string;
}
const VERBS: Verbs = { approve: "Approve", reject: "Reject" };

/** The run an approval belongs to: an approval left pending by a run that ended gets no controls. */
type ApprovalRun = Pick<RunSummary, "runId" | "status" | "workflow" | "startedBy">;

/**
 * What an approval is for and who may decide, as siblings for a flex column: its facts, its
 * details, its links, the held call's input and the messages it ignored. A change's Publish
 * (`asChangeRef`) links its change and shows it at a glance in place of its details.
 */
export function ApprovalDetails({
  run,
  approval,
  showRun = false,
}: {
  run: ApprovalRun;
  approval: ApprovalState;
  /** The run is a fact too, linked. */
  showRun?: boolean;
}) {
  const change = run.workflow === CHANGE_WORKFLOW ? asChangeRef(approval.details) : undefined;
  return (
    <>
      <Facts>
        <Fact label="Approver">{approverLabel(approval.approver)}</Fact>
        <Fact label="Lets through">
          <Covers covers={approval.covers} />
        </Fact>
        <Fact label="Asked by">
          <RequestedBy requestedBy={approval.requestedBy} op={approval.op} reasons={approval.reasons} />
        </Fact>
        <Fact label="Asked">
          <When at={approval.requestedAt} />
        </Fact>
        {change && (
          <Fact label="Change">
            <Link to="/changes/$id" params={{ id: change.change.id }}>
              {change.change.title}
            </Link>
          </Fact>
        )}
        {showRun && (
          <Fact label="Run">
            <Link {...runLink(run)}>
              <code>{run.runId}</code>
            </Link>
          </Fact>
        )}
        {approval.decidedBy && (
          <Fact label="Decided">
            {/* Only an approved one is withdrawn once decided. */}
            {approval.status === "withdrawn" ? "approved" : approval.status} by {approval.decidedBy}
            {approval.alone ? ALONE : null}
            {approval.decidedAt ? (
              <>
                , <When at={approval.decidedAt} />
              </>
            ) : null}
            {approval.note ? <DecisionNote note={approval.note} /> : null}
          </Fact>
        )}
        {approval.status === "withdrawn" && (
          <Fact label="Withdrawn">
            {approval.withdrawnReason}
            {approval.withdrawnBy ? <>, by {approval.withdrawnBy}</> : null}
            {approval.withdrawnAt ? (
              <>
                , <When at={approval.withdrawnAt} />
              </>
            ) : null}
          </Fact>
        )}
      </Facts>
      {change ? <ChangeGlance change={change} /> : <Details details={approval.details} />}
      {approval.links?.length ? (
        <ItemGroup>
          {approval.links.map((href) => (
            <LinkItem key={href} variant="outline" size="xs">
              <a href={href} target="_blank" rel="noreferrer" title={href}>
                <ItemContent>
                  {/* ItemTitle fits its content (w-fit): a long address is cut to the item instead. */}
                  <ItemTitle className="block truncate">{href}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
                </ItemActions>
              </a>
            </LinkItem>
          ))}
        </ItemGroup>
      ) : null}
      {approval.requestedBy === "policy" && approval.input !== undefined && (
        <Expandable label="The held call's input" value={approval.input} />
      )}
      {approval.refused.length > 0 && (
        <Disclosure label={`${plural(approval.refused.length, "message")} ignored`}>
          <ItemGroup>
            {approval.refused.map((r, i) => (
              <Item key={`${r.at}-${i}`} role="listitem" variant="muted" size="xs">
                <ItemContent>
                  <ItemTitle>{r.by ?? "someone"}</ItemTitle>
                  <ItemDescription>{r.reason}</ItemDescription>
                </ItemContent>
                <ItemTime at={r.at} />
              </Item>
            ))}
          </ItemGroup>
        </Disclosure>
      )}
    </>
  );
}

/** An approval's details: the plan, when apply asks (`ApplyPlan`, told by its shape), else their text. */
function Details({ details }: { details: ApprovalState["details"] }) {
  if (!details) return null;
  const plan = asApplyPlan(details);
  return plan ? <ApplyPlanView plan={plan} /> : <p>{details}</p>;
}

/**
 * A pending approval's Approve and Reject, each opening its dialog, as siblings for a wrapping
 * row; or, once its run has ended, why it can no longer be decided.
 */
export function ApprovalDecision({
  run,
  approval,
  verbs = VERBS,
}: {
  run: ApprovalRun;
  approval: ApprovalState;
  verbs?: Verbs;
}) {
  // The decision stays put while the dialog animates closed, so its verb and colour do not flip.
  const [decision, setDecision] = useState<Decision>("approve");
  const [deciding, setDeciding] = useState(false);
  const decide = (chosen: Decision) => {
    setDecision(chosen);
    setDeciding(true);
  };
  // A decision the run has not read yet (no worker running, say) stays queued: until the run's
  // status changes, the controls say so and take no second, different decision.
  const [queued, setQueued] = useState<{ decision: Decision; status: RunStatus }>();
  const waiting = queued?.status === run.status ? queued.decision : undefined;
  if (isEnded(run.status)) {
    return <p className="text-sm text-muted-foreground">The run has {run.status}, so this can no longer be decided.</p>;
  }
  return (
    <>
      <Button disabled={waiting !== undefined} onClick={() => decide("approve")}>
        <CheckIcon aria-hidden="true" data-icon="inline-start" />
        {verbs.approve}
      </Button>
      <Button variant="destructive" disabled={waiting !== undefined} onClick={() => decide("reject")}>
        <XIcon aria-hidden="true" data-icon="inline-start" />
        {verbs.reject}
      </Button>
      {waiting && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="shrink-0" />
          Your {waiting === "approve" ? "approval" : "rejection"} is queued: the run has not read it yet. Is a worker
          running?
        </p>
      )}
      <DecideDialog
        runId={run.runId}
        approval={approval}
        open={deciding}
        decision={decision}
        verbs={verbs}
        onClose={() => setDeciding(false)}
        onQueued={(chosen) => setQueued({ decision: chosen, status: run.status })}
      />
    </>
  );
}

/**
 * The operations an approval stands for, each with its effect: what the approver's sign-off
 * lets a policy allow later in the run. A workflow's approval often covers none.
 */
function Covers({ covers }: { covers: string[] }) {
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  if (covers.length === 0) return <span className="text-muted-foreground">no operation by itself</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {covers.map((id) => (
        <li key={id} className="flex items-center gap-1">
          <OpName id={id} op={ops.get(id)} />
        </li>
      ))}
    </ul>
  );
}

/** Approve or Reject (or the page's `verbs`) with an optional note. Open to anyone: the server says who may decide. */
function DecideDialog({
  runId,
  approval,
  open,
  decision,
  verbs = VERBS,
  onClose,
  onQueued,
}: {
  runId: string;
  approval: ApprovalState;
  open: boolean;
  decision: Decision;
  verbs?: Verbs;
  onClose: () => void;
  /** The run has not read the decision yet: it stays queued, and the card says so. */
  onQueued: (decision: Decision) => void;
}) {
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const send = useServerFn(decideFn);
  const mutation = useMutation({
    // The server trims the note and drops an empty one.
    mutationFn: (chosen: Decision) => send({ data: { runId, approvalId: approval.id, decision: chosen, note } }),
    onSuccess: async (state, chosen) => {
      const refresh = Promise.all([
        queryClient.invalidateQueries({ queryKey: runQuery(runId).queryKey }),
        queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
      ]);
      // Still pending: the decision is queued, but the run has not read it.
      if (state.status === "pending") {
        toast.warning("Sent, but the run has not read it yet. Is a worker running?");
        onQueued(chosen);
      } else {
        toast.success(`${chosen === "approve" ? "Approved" : "Rejected"} “${approval.title}”`);
      }
      setNote("");
      onClose();
      await refresh;
    },
  });
  // An issue with the note belongs under it; anything else (not the approver, already decided,
  // the network) is about the whole decision.
  const body = errorBodyOf(mutation.error);
  const noteError = body?.issues?.find((issue) => issue.path[0] === "note")?.message;
  const error =
    !mutation.error || noteError
      ? undefined
      : body?.code === "not_approver"
        ? body.reason === OWN_CHANGE
          ? `You started this run, so someone else in ${approverLabel(body.approver ?? approval.approver)} must decide this`
          : `Only ${approverLabel(body.approver ?? approval.approver)} can decide this`
        : mutation.error.message;
  const verb = verbs[decision];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) {
          mutation.reset();
          setNote("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate(decision);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {verb} “{approval.title}”?
            </DialogTitle>
            <DialogDescription>
              Asked of {approverLabel(approval.approver)}. The run carries on once decided.
            </DialogDescription>
          </DialogHeader>
          {error && <Notice variant="destructive">{error}</Notice>}
          <Field data-invalid={noteError ? true : undefined}>
            <FieldLabel htmlFor={`note-${approval.id}`}>Note</FieldLabel>
            <Textarea
              id={`note-${approval.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={noteError ? true : undefined}
              placeholder="Optional: why, or what to change"
            />
            <FieldDescription>Recorded in the run's ledger with your decision.</FieldDescription>
            {noteError && <FieldError>{noteError}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={mutation.isPending} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              variant={decision === "reject" ? "destructive" : "default"}
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              {verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
