import type { ApprovalState, RunSummary } from "@sanoma/workflows";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { approverName, type DecideRequest, errorBodyOf } from "../api.ts";
import { decideFn } from "../functions.ts";
import { ApprovalStatusBadge, Disclosure, Expandable, Fact, Facts, plural, When } from "./common.tsx";

type Decision = DecideRequest["decision"];

/** An approval: what it is for, who may decide, and the controls to decide while it is pending. */
export function ApprovalCard({
  runId,
  approval,
  run,
}: {
  runId: string;
  approval: ApprovalState;
  /** The run it belongs to, for an approval shown away from its run: named under the title, and linked. */
  run?: Pick<RunSummary, "workflow" | "startedBy">;
}) {
  const [deciding, setDeciding] = useState<Decision | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{approval.title}</CardTitle>
        {run && (
          <CardDescription>
            {run.workflow}, started by {run.startedBy?.id ?? "unknown"}
          </CardDescription>
        )}
        <CardAction>
          <ApprovalStatusBadge status={approval.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Facts>
          <Fact label="Approver">{approverName(approval.approver)}</Fact>
          <Fact label="Asked by">
            {approval.requestedBy === "policy" ? (
              <>
                the policy, holding <code>{approval.op}</code>
              </>
            ) : (
              "the workflow"
            )}
          </Fact>
          <Fact label="Asked">
            <When at={approval.requestedAt} />
          </Fact>
          {run && (
            <Fact label="Run">
              <Link to="/runs/$id" params={{ id: runId }} className="underline underline-offset-4">
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
              {approval.note ? <q className="block text-muted-foreground italic">{approval.note}</q> : null}
            </Fact>
          )}
        </Facts>
        {approval.details && <p>{approval.details}</p>}
        {approval.links?.length ? (
          <ul className="flex flex-col gap-1">
            {approval.links.map((href) => (
              <li key={href} className="break-all">
                <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-4">
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
      {approval.status === "pending" && (
        <CardFooter className="flex-wrap gap-2">
          <Button onClick={() => setDeciding("approve")}>
            <CheckIcon data-icon="inline-start" />
            Approve
          </Button>
          <Button variant="destructive" onClick={() => setDeciding("reject")}>
            <XIcon data-icon="inline-start" />
            Reject
          </Button>
        </CardFooter>
      )}
      {approval.status === "pending" && (
        <DecideDialog runId={runId} approval={approval} decision={deciding} onClose={() => setDeciding(null)} />
      )}
    </Card>
  );
}

/** Approve or Reject with an optional note. Open to anyone: the server says who may decide. */
function DecideDialog({
  runId,
  approval,
  decision,
  onClose,
}: {
  runId: string;
  approval: ApprovalState;
  decision: Decision | null;
  onClose: () => void;
}) {
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const send = useServerFn(decideFn);
  const messageOf = (err: Error | null) => {
    const body = errorBodyOf(err);
    return body?.code === "not_approver"
      ? `Only ${approverName(body.approver ?? approval.approver)} can decide this`
      : err?.message;
  };
  const mutation = useMutation({
    // The server trims the note and drops an empty one.
    mutationFn: (chosen: Decision) => send({ data: { runId, approvalId: approval.id, decision: chosen, note } }),
    onSuccess: async (_, chosen) => {
      toast.success(`${chosen === "approve" ? "Approved" : "Rejected"} “${approval.title}”`);
      setNote("");
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["run", runId] }),
        queryClient.invalidateQueries({ queryKey: ["runs"] }),
      ]);
    },
  });
  const error = messageOf(mutation.error);
  const verb = decision === "reject" ? "Reject" : "Approve";

  return (
    <Dialog
      open={decision !== null}
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) {
          mutation.reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (decision) mutation.mutate(decision);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {verb} “{approval.title}”?
            </DialogTitle>
            <DialogDescription>
              Asked of {approverName(approval.approver)}. The run carries on once decided.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`note-${approval.id}`}>Note</FieldLabel>
            <Textarea
              id={`note-${approval.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={error ? true : undefined}
              placeholder="Optional: why, or what to change"
            />
            <FieldDescription>Recorded in the run's ledger with your decision.</FieldDescription>
            {error && <FieldError>{error}</FieldError>}
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
