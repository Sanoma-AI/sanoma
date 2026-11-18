import { approverLabel } from "sanoma/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { useActor } from "../../actor.ts";
import { pendingApprovals } from "../../api.ts";
import { decidableBy } from "../../lib/decidable.ts";
import { approvalKey, configQuery, runQuery } from "../../queries.ts";
import { ApprovalDecision, ApprovalDetails } from "../approval.tsx";
import { CardHeading } from "../kit.tsx";

/**
 * A held call or start (the agent catalog's `lookup`, `start_run` or `drift`): the Inbox's approval card while you may decide it, else who it waits for with a
 * link to the Inbox; once decided, its status.
 */
export default function HeldCard({ runId }: { runId: string }) {
  const { actor, groups } = useActor();
  const { data: people } = useSuspenseQuery({ ...configQuery(), select: (config) => config.resources });
  const { data } = useQuery(runQuery(runId));
  if (!data) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Asking for an approval…
      </p>
    );
  }
  const { run } = data;
  const approval = pendingApprovals(data)[0] ?? data.approvals.at(-1);
  if (!approval) return null;
  const entry = { run, approval };
  if (approval.status === "pending" && decidableBy(actor, groups, people)([entry]).length === 0) {
    return (
      <p className="text-muted-foreground">
        Waiting for {approverLabel(approval.approver)}:{" "}
        <Link to="/inbox" search={{ approval: approvalKey(entry) }} className="underline underline-offset-4">
          in the Inbox
        </Link>
        .
      </p>
    );
  }
  return (
    <Card size="sm" role="region" aria-label={approval.title}>
      <CardHeader>
        <CardHeading>{approval.title}</CardHeading>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ApprovalDetails run={run} approval={approval} showRun />
      </CardContent>
      {approval.status === "pending" && (
        <CardFooter className="flex-wrap gap-2">
          <ApprovalDecision run={run} approval={approval} />
        </CardFooter>
      )}
    </Card>
  );
}
