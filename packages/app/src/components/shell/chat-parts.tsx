import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { approverLabel } from "@sanoma-ai/workflows/shared";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getToolName, isToolUIPart } from "ai";
import { type FormEvent, memo, Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader } from "#/components/ui/card.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { actorHeaders, useActor } from "../../actor.ts";
import { pendingApprovals } from "../../api.ts";
import { type ChatMessage, type DraftCard, heldRunOf, pathOf, type SignInCard, textOf } from "../../lib/chat.ts";
import { decidableBy } from "../../lib/decidable.ts";
import { approvalKey, configQuery, runQuery } from "../../queries.ts";
import { ApprovalDecision, ApprovalDetails } from "../approval.tsx";
import { CardHeading, TipButton } from "../common.tsx";
import { DraftCardView } from "./draft-card.tsx";

// What the chat draws of the agent's reply, per app.md's Chat: plain text at the reply size, the
// steps as a quiet checked list, a held lookup as the Inbox's approval card, and the draft as a
// small card, and a person's own agent's sign-in as its card. Any engine's reply: a tool part of
// another engine is a step by its title or name.

type Part = ChatMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/**
 * The agent's reply in the chat `chat`: its parts in order (steps grouped into one list), a
 * sign-in's card, its draft's card last, and Copy. Memoized: a streamed chunk redraws only the
 * reply it belongs to.
 */
export const Reply = memo(function Reply({
  message,
  live,
  chat,
}: {
  message: ChatMessage;
  live: boolean;
  chat: string;
}) {
  const blocks: ({ steps: ToolPart[] } | { part: Part })[] = [];
  let draft: DraftCard | undefined;
  let signIn: SignInCard | undefined;
  for (const part of message.parts) {
    if (part.type === "data-draft") draft = part.data;
    else if (part.type === "data-signIn") signIn = part.data;
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
      {signIn && <SignInCardView card={signIn} chat={chat} live={live} />}
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
    case "take_app":
    case "update_app": {
      const taken = getToolName(step) === "take_app";
      const what = taken
        ? `Took the app from ${String(input.url ?? "")}`
        : `Updated apps/${String(input.folder ?? "")}`;
      const result =
        step.state === "output-available"
          ? (step.output as { merged?: number; conflicts?: string[] } | undefined)
          : undefined;
      if (!taken && result?.merged === 0) return `apps/${String(input.folder ?? "")} is up to date`;
      const conflicts = result?.conflicts?.length ?? 0;
      return conflicts ? `${what}: ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"} to resolve` : what;
    }
    case "lookup":
      return `Looked up ${String(input.op ?? "")}`;
    default: {
      if (step.title) return step.title;
      const file = pathOf(input);
      return file === undefined ? getToolName(step) : `${getToolName(step)} ${file}`;
    }
  }
}

/** `url` when it is an https link that parses (the vendor wrote it), else undefined. */
function httpsLink(url: string | undefined): URL | undefined {
  try {
    const link = new URL(url ?? "");
    return link.protocol === "https:" ? link : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A person's own agent's sign-in: the vendor's link and what it printed (its code among it), a
 * field for a code the vendor asks to have pasted back (written to its sign-in, `POST
 * /api/sign-in`), or the command to run once on this computer; then whether it finished. The
 * sign-in is the person's: the app opens no link and enters no code.
 */
function SignInCardView({ card, chat, live }: { card: SignInCard; chat: string; live: boolean }) {
  const { agent, state } = card;
  const [code, setCode] = useState("");
  const [sent, setSent] = useState<string>();
  const paste = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    const response = await fetch("/api/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json", ...actorHeaders() },
      body: JSON.stringify({ chat, code }),
    }).catch(() => undefined);
    setCode("");
    setSent(response?.ok ? `Sent to ${agent}'s sign-in.` : `${agent}'s sign-in is not waiting for a code any more.`);
  };
  // An https link only, and one that parses: the vendor wrote it.
  const link = httpsLink(card.url);
  return (
    <Card size="sm" role="region" aria-label={`Sign in to ${agent}`}>
      <CardHeader>
        <CardHeading>Sign in to {agent}</CardHeading>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {state === "waiting" && !live ? (
          <p className="text-muted-foreground">
            The sign-in stopped before it finished. Send your message again to start over.
          </p>
        ) : state === "waiting" ? (
          <>
            <p className="text-muted-foreground">
              This sign-in is yours, on your own {agent} plan. Sanoma opens no link, enters no code and reads nothing{" "}
              {agent} gives back. The chat waits until you finish.
            </p>
            {card.text ? (
              <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{card.text}</pre>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner /> Starting {agent}'s sign-in…
              </p>
            )}
            {link && (
              <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                Open {link.host} to sign in
              </a>
            )}
            {card.asks && (
              <form onSubmit={(e) => void paste(e)} className="flex gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-label={`The code ${agent} gave you`}
                  placeholder="Paste the code here"
                  autoComplete="off"
                />
                <Button type="submit" size="sm" variant="secondary" disabled={!code.trim()}>
                  Send
                </Button>
              </form>
            )}
            {sent && <p className="text-muted-foreground">{sent}</p>}
          </>
        ) : state === "once" ? (
          <>
            <p>
              {agent} signs in only in a terminal of its own. Run this once on this computer, then send your message
              again:
            </p>
            <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{card.command}</pre>
            {card.after && (
              <p>
                Then type <code>{card.after}</code> in it and sign in.
              </p>
            )}
          </>
        ) : state === "done" ? (
          <p className="flex items-center gap-1.5">
            <CheckIcon aria-hidden="true" /> Signed in to {agent}. Send your message again.
          </p>
        ) : (
          <p className="text-destructive">
            The sign-in did not finish: {card.text}. Send your message again to start over.
          </p>
        )}
      </CardContent>
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
