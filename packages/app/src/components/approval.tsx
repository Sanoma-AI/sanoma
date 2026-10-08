import type { ApprovalState, RunStatus, RunSummary } from "@sanoma/workflows";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card.tsx";
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
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { approverLabel, isEnded } from "@sanoma/workflows/shared";
import { type DecideRequest, errorBodyOf, starterName } from "../api.ts";
import { decideFn } from "../functions.ts";
import { configQuery, opsById } from "../queries.ts";
import {
  ApprovalStatusBadge,
  DecisionNote,
  Disclosure,
  Expandable,
  Fact,
  Facts,
  Notice,
  OpName,
  plural,
  RequestedBy,
  When,
} from "./common.tsx";

type Decision = DecideRequest["decision"];

/**
 * An approval: what it is for, who may decide, and the controls to decide while it is pending
 * and its run can still read a decision.
 */
export function ApprovalCard({
  runId,
  runStatus,
  approval,
  run,
}: {
  runId: string;
  /** The run's status: an approval left pending by a run that ended gets no controls. */
  runStatus: RunStatus;
  approval: ApprovalState;
  /** The run it belongs to, for an approval shown away from its run: named under the title, and linked. */
  run?: Pick<RunSummary, "workflow" | "startedBy">;
}) {
  const decidable = approval.status === "pending" && !isEnded(runStatus);
  // The decision stays put while the dialog animates closed, so its verb and colour do not flip.
  const [decision, setDecision] = useState<Decision>("approve");
  const [deciding, setDeciding] = useState(false);
  const decide = (chosen: Decision) => {
    setDecision(chosen);
    setDeciding(true);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{approval.title}</CardTitle>
        {run && (
          <CardDescription>
            {run.workflow}, started by {starterName(run)}
          </CardDescription>
        )}
        <CardAction>
          <ApprovalStatusBadge status={approval.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Facts>
          <Fact label="Approver">{approverLabel(approval.approver)}</Fact>
          <Fact label="Lets through">
            <Covers covers={approval.covers} />
          </Fact>
          <Fact label="Asked by">
            <RequestedBy requestedBy={approval.requestedBy} op={approval.op} />
          </Fact>
          <Fact label="Asked">
            <When at={approval.requestedAt} />
          </Fact>
          {run && (
            <Fact label="Run">
              <Link to="/runs/$id" params={{ id: runId }}>
                <code>{runId}</code>
              </Link>
            </Fact>
          )}
          {approval.decidedBy && (
            <Fact label="Decided">
              {approval.status} by {approval.decidedBy}
              {approval.decidedAt ? (
                <>
                  , <When at={approval.decidedAt} />
                </>
              ) : null}
              {approval.note ? <DecisionNote note={approval.note} /> : null}
            </Fact>
          )}
        </Facts>
        {approval.details && <p>{approval.details}</p>}
        {approval.links?.length ? (
          <ul className="flex flex-col gap-1">
            {approval.links.map((href) => (
              <li key={href} className="break-all">
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
          <Disclosure label={`${plural(approval.refused.length, "message")} ignored`}>
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {approval.refused.map((r, i) => (
                <li key={`${r.at}-${i}`}>
                  {r.by ?? "someone"}: {r.reason} (<When at={r.at} />)
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </CardContent>
      {approval.status === "pending" && !decidable && (
        <CardFooter>
          <p className="text-sm text-muted-foreground">The run has {runStatus}, so this can no longer be decided.</p>
        </CardFooter>
      )}
      {decidable && (
        <CardFooter className="flex-wrap gap-2">
          <Button onClick={() => decide("approve")}>
            <CheckIcon data-icon="inline-start" />
            Approve
          </Button>
          <Button variant="destructive" onClick={() => decide("reject")}>
            <XIcon data-icon="inline-start" />
            Reject
          </Button>
        </CardFooter>
      )}
      {decidable && (
        <DecideDialog
          runId={runId}
          approval={approval}
          open={deciding}
          decision={decision}
          onClose={() => setDeciding(false)}
        />
      )}
    </Card>
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
          <OpName id={id} effect={ops.get(id)?.effect} />
        </li>
      ))}
    </ul>
  );
}

/** Approve or Reject with an optional note. Open to anyone: the server says who may decide. */
function DecideDialog({
  runId,
  approval,
  open,
  decision,
  onClose,
}: {
  runId: string;
  approval: ApprovalState;
  open: boolean;
  decision: Decision;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const send = useServerFn(decideFn);
  const mutation = useMutation({
    // The server trims the note and drops an empty one.
    mutationFn: (chosen: Decision) => send({ data: { runId, approvalId: approval.id, decision: chosen, note } }),
    onSuccess: async (state, chosen) => {
      const refresh = Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
      // Still pending: the decision is queued, but the run has not read it. The dialog stays
      // open, so the approver sees that nothing has happened yet.
      if (state.status === "pending") {
        toast.warning("Sent, but the run has not read it yet. Is a worker running?");
      } else {
        toast.success(`${chosen === "approve" ? "Approved" : "Rejected"} “${approval.title}”`);
        setNote("");
        onClose();
      }
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
        ? `Only ${approverLabel(body.approver ?? approval.approver)} can decide this`
        : mutation.error.message;
  const verb = decision === "reject" ? "Reject" : "Approve";

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
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
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
