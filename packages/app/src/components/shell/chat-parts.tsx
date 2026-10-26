import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { GitBranchIcon } from "@phosphor-icons/react/dist/csr/GitBranch";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getToolName, isToolUIPart } from "ai";
import { memo, Suspense } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { useActor } from "../../actor.ts";
import { pendingApprovals } from "../../api.ts";
import { type ChatMessage, type DraftCard, heldRunOf, pathOf, textOf } from "../../lib/chat.ts";
import { decidableBy } from "../../lib/decidable.ts";
import { approvalKey, configQuery, runQuery } from "../../queries.ts";
import { ApprovalDecision, ApprovalDetails } from "../approval.tsx";
import { CardHeading, plural, TipButton } from "../common.tsx";

// What the chat draws of the agent's reply, per app.md's Chat: plain text at the reply size, the
// steps as a quiet checked list, a held lookup as the Inbox's approval card, and the draft as a
// small card. Any engine's reply: a tool part of another engine is a step by its name.

type Part = ChatMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/**
 * The agent's reply: its parts in order (steps grouped into one list), its draft's card last, and
 * Copy. Memoized: a streamed chunk redraws only the reply it belongs to.
 */
export const Reply = memo(function Reply({ message, live }: { message: ChatMessage; live: boolean }) {
  const blocks: ({ steps: ToolPart[] } | { part: Part })[] = [];
  let draft: DraftCard | undefined;
  for (const part of message.parts) {
    if (part.type === "data-draft") draft = part.data;
    else if (isToolUIPart(part) && heldRunOf(part.output) === undefined) {
      const last = blocks.at(-1);
      if (last && "steps" in last) last.steps.push(part);
      else blocks.push({ steps: [part] });
    } else blocks.push({ part });
  }
  const text = textOf(message);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, i) =>
        "steps" in block ? <Steps key={i} steps={block.steps} live={live} /> : <ReplyPart key={i} part={block.part} />,
      )}
      {draft && <DraftCardView draft={draft} />}
      {text && !live && (
        <div className="-ml-1.5 flex">
          <TipButton
            tip="Copy"
            size="icon-xs"
            onClick={() =>
              void navigator.clipboard.writeText(text).then(
                () => toast.success("Copied"),
                () => toast.error("Could not copy"),
              )
            }
          >
            <CopyIcon aria-hidden="true" />
          </TipButton>
        </div>
      )}
    </div>
  );
});

function ReplyPart({ part }: { part: Part }) {
  if (part.type === "text") return <p className="text-reply whitespace-pre-wrap">{part.text}</p>;
  if (isToolUIPart(part)) {
    const runId = heldRunOf(part.output);
    if (runId !== undefined) {
      return (
        <Suspense fallback={<Spinner />}>
          <HeldCard runId={runId} />
        </Suspense>
      );
    }
  }
  return null;
}

/** The steps as a quiet checked list: each done, failed or refused (with why), or under way. */
function Steps({ steps, live }: { steps: ToolPart[]; live: boolean }) {
  return (
    <ul aria-label="Steps" className="flex flex-col gap-1 text-xs text-muted-foreground">
      {steps.map((step) => (
        <li key={step.toolCallId} className="flex items-start gap-1.5">
          <StepIcon step={step} live={live} />
          <span className="min-w-0">
            <span className="break-words">{stepLabel(step)}</span>
            {step.state === "output-error" && <span className="block text-destructive">{step.errorText}</span>}
            {refused(step) && step.approval?.reason && <span className="block">{step.approval.reason}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StepIcon({ step, live }: { step: ToolPart; live: boolean }) {
  const icon = "mt-0.5 size-3.5 shrink-0";
  if (step.state === "output-error") return <XIcon aria-label="Failed" className={`${icon} text-destructive`} />;
  if (refused(step)) return <XIcon aria-label="Refused" className={icon} />;
  if (step.state === "output-available" && !step.preliminary) return <CheckIcon aria-label="Done" className={icon} />;
  // A step that was under way when the turn stopped is neither: it stopped there.
  return live ? <Spinner aria-label="Under way" className={icon} /> : <XIcon aria-label="Stopped" className={icon} />;
}

/** A coding agent's step its checkout rule refused (`HarnessAgent`'s built-in tool, answered no). */
const refused = (step: ToolPart) => step.approval?.approved === false;

/** A step in words: what the tool did, from its input; a coding agent's by its tool's name and the file it names. */
function stepLabel(step: ToolPart): string {
  const input = (step.input ?? {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : "";
  switch (getToolName(step)) {
    case "read_file":
      return `Read ${path}`;
    case "list_files":
      return `Listed ${path === "." || !path ? "the files" : path}`;
    case "grep":
      return `Searched for ${String(input.pattern ?? "")}`;
    case "write_file":
      return `Wrote ${path}`;
    case "edit_file":
      return `Edited ${path}`;
    case "run_checks": {
      const result = step.state === "output-available" ? (step.output as { ok?: boolean } | undefined) : undefined;
      return result === undefined
        ? "Ran the checks"
        : result.ok
          ? "Ran the checks: they pass"
          : "Ran the checks: they fail";
    }
    case "lookup":
      return `Looked up ${String(input.op ?? "")}`;
    default: {
      const file = pathOf(input);
      return file === undefined ? getToolName(step) : `${getToolName(step)} ${file}`;
    }
  }
}

/**
 * The draft's card: its branch, what it changes (git's summary), its checks, and how it is
 * applied: merging its branch, by hand; the live instance runs the old code until it restarts.
 */
function DraftCardView({ draft }: { draft: DraftCard }) {
  const { checks } = draft;
  return (
    <Card size="sm" role="region" aria-label="Draft">
      <CardHeader>
        <CardHeading>
          <span className="flex items-center gap-1.5">
            <GitBranchIcon aria-hidden="true" className="shrink-0" />
            <code className="truncate">{draft.branch}</code>
          </span>
        </CardHeading>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {draft.summary ? (
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre">{draft.summary}</pre>
        ) : (
          <p className="text-muted-foreground">No change committed yet.</p>
        )}
        {checks === undefined ? (
          <p className="text-muted-foreground">Not checked since the last edit.</p>
        ) : checks.ok ? (
          <p className="flex items-center gap-1.5">
            <CheckIcon aria-hidden="true" /> Checks pass
            {checks.warnings.length > 0 && `, with ${plural(checks.warnings.length, "warning")}`}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-destructive">
              <XIcon aria-hidden="true" /> Checks fail: {plural(checks.problems.length, "problem")}
            </p>
            <ul className="list-disc pl-5 font-mono text-xs break-words">
              {checks.problems.map((problem, i) => (
                <li key={i}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t text-xs text-muted-foreground">
        Merge the branch to apply it. The live instance keeps running the old code until it restarts.
      </CardFooter>
    </Card>
  );
}

/**
 * A held lookup: the Inbox's approval card while you may decide it, else who it waits for with a
 * link to the Inbox; once decided, its status.
 */
function HeldCard({ runId }: { runId: string }) {
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
