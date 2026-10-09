import type { ApprovalState, RunStatus, RunSummary } from "@sanoma/workflows";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckIcon, ExternalLinkIcon, XIcon } from "lucide-react";
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { approverLabel, isEnded } from "@sanoma/workflows/shared";
import { type DecideRequest, errorBodyOf, starterName } from "../api.ts";
import { decideFn } from "../functions.ts";
import { configQuery, opsById, RUNS_KEY, runQuery } from "../queries.ts";
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
  run,
  approval,
  showRun = false,
}: {
  /** The run it belongs to: an approval left pending by a run that ended gets no controls. */
  run: Pick<RunSummary, "runId" | "status" | "workflow" | "startedBy">;
  approval: ApprovalState;
  /** For an approval shown away from its run: the run is named under the title, and linked. */
  showRun?: boolean;
}) {
  // The decision stays put while the dialog animates closed, so its verb and colour do not flip.
  const [decision, setDecision] = useState<Decision>("approve");
  const [deciding, setDeciding] = useState(false);
  const decide = (chosen: Decision) => {
    setDecision(chosen);
    setDeciding(true);
  };
  // A decision the run has not read yet (no worker running, say) stays queued: until the run's
  // status changes, the card says so and takes no second, different decision.
  const [queued, setQueued] = useState<{ decision: Decision; status: RunStatus }>();
  const waiting = queued?.status === run.status ? queued.decision : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{approval.title}</CardTitle>
        {showRun && (
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
          {showRun && (
            <Fact label="Run">
              <Link to="/runs/$id" params={{ id: run.runId }}>
                <code>{run.runId}</code>
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
        {/* A list of links: each Item is the <a> itself, which cannot also be a listitem, so the
            list is a <ul> rather than an ItemGroup. */}
        {approval.links?.length ? (
          <ul className="flex flex-col gap-2">
            {approval.links.map((href) => (
              <li key={href}>
                <Item asChild variant="outline" size="xs">
                  <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
                    <ItemContent className="min-w-0">
                      {/* ItemTitle fits its content (w-fit): a long address is cut to the item instead. */}
                      <ItemTitle className="block max-w-full truncate">{href}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <ExternalLinkIcon className="size-4" />
                    </ItemActions>
                  </a>
                </Item>
              </li>
            ))}
          </ul>
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
                  <ItemActions className="text-xs text-muted-foreground">
                    <When at={r.at} />
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </Disclosure>
        )}
      </CardContent>
      {approval.status === "pending" &&
        (isEnded(run.status) ? (
          <CardFooter>
            <p className="text-sm text-muted-foreground">The run has {run.status}, so this can no longer be decided.</p>
          </CardFooter>
        ) : (
          <>
            <CardFooter className="flex-wrap gap-2">
              <Button disabled={waiting !== undefined} onClick={() => decide("approve")}>
                <CheckIcon data-icon="inline-start" />
                Approve
              </Button>
              <Button variant="destructive" disabled={waiting !== undefined} onClick={() => decide("reject")}>
                <XIcon data-icon="inline-start" />
                Reject
              </Button>
              {waiting && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="shrink-0" />
                  Your {waiting === "approve" ? "approval" : "rejection"} is queued: the run has not read it yet. Is a
                  worker running?
                </p>
              )}
            </CardFooter>
            <DecideDialog
              runId={run.runId}
              approval={approval}
              open={deciding}
              decision={decision}
              onClose={() => setDeciding(false)}
              onQueued={(chosen) => setQueued({ decision: chosen, status: run.status })}
            />
          </>
        ))}
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
          <OpName id={id} op={ops.get(id)} />
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
  onQueued,
}: {
  runId: string;
  approval: ApprovalState;
  open: boolean;
  decision: Decision;
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
