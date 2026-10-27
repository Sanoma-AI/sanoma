import type { ChangeView } from "@sanoma-ai/workflows";
import { APPLY_WORKFLOW, CHANGE_MERGE, CHANGE_WORKFLOW, DRIFT_WORKFLOW } from "@sanoma-ai/workflows/shared";
import { Link } from "@tanstack/react-router";
import { CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { approverName } from "#/lib/changes.ts";
import { cn } from "#/lib/utils.ts";
import { runLink } from "../queries.ts";
import { ApprovalDecision, type Verbs } from "./approval.tsx";
import { CardHeading, Fact, Facts, FLOAT, FloatingCard, When } from "./common.tsx";

/** Publish's buttons: the merge approval decided as any approval is, in the ops manager's words. */
const PUBLISH: Verbs = { approve: "Publish", reject: "Reject" };

/**
 * A change's decision, floating over its review: the policy's answer as a sentence, the facts
 * beside it (the checks, the card on the host, the merge and its deploy once merged), and, while
 * Publish waits, Publish and Reject on it. Rejecting closes the change: its run closes the pull
 * request itself.
 */
export function ChangeDecision({ change }: { change: ChangeView }) {
  const { state } = change;
  const run = { ...change, workflow: CHANGE_WORKFLOW };
  const publish = change.approvals.find((a) => a.status === "pending" && a.covers.includes(CHANGE_MERGE));
  return (
    <FloatingCard role="region" aria-label="Publish" className={cn(FLOAT, "order-first")}>
      <CardHeader className="border-b">
        <CardHeading>Publish</CardHeading>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <Answer state={state} />
        <Facts>
          <Fact label="Checks">
            {!state.check ? (
              <span className="text-muted-foreground">not run yet</span>
            ) : state.check.ok ? (
              "pass"
            ) : (
              <ul className="flex flex-col gap-1">
                {state.check.problems.map((problem, i) => (
                  <li key={i}>
                    <code className="text-xs">{problem}</code>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          <Fact label="Card">{state.card.reason}</Fact>
          {state.merged && <Merged merged={state.merged} />}
        </Facts>
      </CardContent>
      {publish && (
        <CardFooter className="flex-wrap gap-2">
          <ApprovalDecision run={run} approval={publish} verbs={PUBLISH} />
          <p className="w-full text-sm text-muted-foreground">Rejecting closes the change.</p>
        </CardFooter>
      )}
    </FloatingCard>
  );
}

/**
 * Where the change stands with the policy, as a sentence with the rule behind it: published or
 * closed once it is, else what the policy answered its merge (`state.decision`), asked ahead.
 */
function Answer({ state }: { state: ChangeView["state"] }) {
  const { decision } = state;
  let said: string;
  if (state.phase === "merged") said = "Published";
  else if (state.phase === "closed") said = state.closedBy ? `Closed by ${state.closedBy}` : "Closed";
  else if (!decision) said = "The policy has not been asked yet";
  else if (decision.answer === "deny") said = `Refused: ${decision.reason ?? "the policy denies it"}`;
  else if (decision.answer === "hold") said = `Publish waits for ${approverName(decision.approver!)}`;
  else said = decision.approver ? `Allowed: Publish is for ${approverName(decision.approver)}` : "Allowed";
  const rule = decision?.title ?? decision?.reasons?.join(", ");
  return (
    <div className="flex flex-col gap-0.5">
      <p className="font-medium">{said}</p>
      {rule && state.phase !== "merged" && state.phase !== "closed" && (
        <p className="text-sm text-muted-foreground">{rule}</p>
      )}
    </div>
  );
}

/** What the merge did: its commit, then the checkout following `main`, the hosts' apply and drift's read back. */
function Merged({ merged }: { merged: NonNullable<ChangeView["state"]["merged"]> }) {
  const { deploy, verified } = merged;
  const follow = deploy?.follow;
  return (
    <>
      <Fact label="Merged">
        <code title={merged.sha}>{merged.sha.slice(0, 8)}</code>, <When at={merged.at} />
      </Fact>
      {follow && (
        <Fact label="This computer">
          {"revision" in follow
            ? `follows main at ${follow.revision.slice(0, 8)}`
            : "skipped" in follow
              ? `did not follow main: ${follow.skipped}`
              : `could not follow main: ${follow.error}`}
        </Fact>
      )}
      {deploy?.apply && (
        <Fact label="Deploy">
          <Link {...runLink({ runId: deploy.apply.runId, workflow: APPLY_WORKFLOW })}>the hosts' apply</Link>
          {deploy.apply.error ? `: ${deploy.apply.error}` : ""}
        </Fact>
      )}
      {verified && (
        <Fact label="Verified">
          <Link {...runLink({ runId: verified.runId, workflow: DRIFT_WORKFLOW })}>drift</Link>
          {verified.error
            ? `: ${verified.error}`
            : verified.drifted.length > 0
              ? `: not as declared: ${verified.drifted.join(", ")}`
              : ": as declared"}
        </Fact>
      )}
    </>
  );
}
