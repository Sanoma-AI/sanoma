import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { getToolName, isToolUIPart } from "ai";
import { CatchBoundary } from "@tanstack/react-router";
import { type FormEvent, lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "#/components/ui/card.tsx";
import { CodeBlock, CodeBlockContent } from "#/components/ui/code-block.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Message, MessageContent, MessageFooter } from "#/components/ui/message.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "#/components/ui/trace.tsx";
import { actorHeaders } from "../../actor.ts";
import { type ChatMessage, type DraftCard, heldRunOf, pathOf, type SignInCard, textOf } from "../../lib/chat.ts";
import { CardHeading, Notice, TipButton } from "../kit.tsx";
import { DraftCardView } from "./draft-card.tsx";

// What the chat draws of the agent's reply, per app.md's Chat: Markdown at the reply size, its
// thinking and steps as one quiet trace (AI Elements' Reasoning and Tool), a held call or start as the
// Inbox's approval card, the draft as a small card, a person's own agent's sign-in as its card,
// and the last reply's suggested asks as buttons. Any engine's reply: a tool part of another
// engine is a step by its title or name.

/** Off the chrome's chunk, which every page loads: until it comes, a reply's text as it is. */
const Markdown = lazy(() => import("./markdown.tsx"));
const HeldCard = lazy(() => import("./held-card.tsx"));

type Part = ChatMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;
type ReasoningPart = Extract<Part, { type: "reasoning" }>;
type TracePart = ToolPart | ReasoningPart;

/**
 * The agent's reply in the chat `chat`: its parts in order (thinking and steps side by side
 * grouped into one trace), a sign-in's card, its draft's card last, and Copy.
 */
export function Reply({ message, live, chat }: { message: ChatMessage; live: boolean; chat: string }) {
  const blocks: ({ trace: TracePart[] } | { part: Part })[] = [];
  let draft: DraftCard | undefined;
  let signIn: SignInCard | undefined;
  for (const part of message.parts) {
    if (part.type === "data-draft") draft = part.data;
    else if (part.type === "data-signIn") signIn = part.data;
    else if (part.type === "step-start") continue;
    else if (part.type === "reasoning" || (isToolUIPart(part) && heldRunOf(part.output) === undefined)) {
      const last = blocks.at(-1);
      if (last && "trace" in last) last.trace.push(part);
      else blocks.push({ trace: [part] });
    } else blocks.push({ part });
  }
  const text = textOf(message);
  return (
    <Message>
      <MessageContent className="gap-3">
        {blocks.map((block, i) =>
          "trace" in block ? (
            <ReplyTrace key={i} parts={block.trace} live={live} />
          ) : (
            <ReplyPart key={i} part={block.part} live={live} />
          ),
        )}
        {signIn && <SignInCardView card={signIn} chat={chat} live={live} />}
        {draft && <DraftCardView draft={draft} />}
        {text && !live && (
          <MessageFooter className="-ml-1.5 px-0">
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
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function ReplyPart({ part, live }: { part: Part; live: boolean }) {
  if (part.type === "text") {
    const plain = <p className="text-reply whitespace-pre-wrap">{part.text}</p>;
    return (
      // A chunk that does not come (a deploy since the page loaded) leaves the text as it is.
      <CatchBoundary getResetKey={() => "markdown"} errorComponent={() => plain}>
        <Suspense fallback={plain}>
          <Markdown text={part.text} live={live && part.state === "streaming"} />
        </Suspense>
      </CatchBoundary>
    );
  }
  if (isToolUIPart(part)) {
    const runId = heldRunOf(part.output);
    if (runId !== undefined) {
      return (
        <CatchBoundary getResetKey={() => runId} errorComponent={HeldCardMissing}>
          <Suspense fallback={<Spinner />}>
            <HeldCard runId={runId} />
          </Suspense>
        </CatchBoundary>
      );
    }
  }
  return null;
}

function HeldCardMissing() {
  return <Notice variant="destructive">This approval did not load. Reload the page to see it.</Notice>;
}

/** The agent's thinking and steps as a quiet trace, a line each. */
function ReplyTrace({ parts, live }: { parts: TracePart[]; live: boolean }) {
  return (
    <Trace role="group" aria-label="Steps" className="gap-1">
      {parts.map((part, i) =>
        part.type === "reasoning" ? (
          <Reasoning key={`reasoning-${i}`} part={part} live={live} />
        ) : (
          <Step key={`step-${part.toolCallId}`} step={part} live={live} />
        ),
      )}
    </Trace>
  );
}

/**
 * Thinking, open while it streams and folded once it is done, unless the person chose otherwise.
 * Thinking with no text (a model that keeps it to itself) shows only while it is under way.
 */
function Reasoning({ part, live }: { part: ReasoningPart; live: boolean }) {
  const running = live && part.state === "streaming";
  const [open, setOpen] = useState<boolean>();
  const title = (
    <TraceLine status={running ? "running" : undefined} className="text-xs">
      <TraceIcon>
        <SparkleIcon aria-hidden="true" />
      </TraceIcon>
      <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
    </TraceLine>
  );
  if (!part.text) return running ? title : null;
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>{title}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="text-xs whitespace-pre-wrap">{part.text}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A step: done, under way or stopped as a line, and failed or refused with why, open beneath it. */
function Step({ step, live }: { step: ToolPart; live: boolean }) {
  const label = stepLabel(step);
  const { word, status, icon, why } = stepState(step, live);
  const line = (
    <TraceLine status={status} className="text-xs">
      <TraceIcon>{icon}</TraceIcon>
      <TraceTitle title={label}>
        <span className="sr-only">{word}: </span>
        {label}
      </TraceTitle>
    </TraceLine>
  );
  if (!why) return line;
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="text-xs">
        {status === "error" ? (
          <CodeBlock size="sm" variant="destructive">
            <CodeBlockContent wrap className="max-h-64">
              {why}
            </CodeBlockContent>
          </CodeBlock>
        ) : (
          why
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * A step's state: in a word for a screen reader (the trace's icons are hidden from one), its line's
 * status, its icon, and why when it failed or was refused (a coding agent's step its checkout rule
 * answered no, `HarnessAgent`'s built-in tool).
 */
function stepState(step: ToolPart, live: boolean) {
  const stopped = <XIcon aria-hidden="true" />;
  if (step.state === "output-error") {
    return { word: "Failed", status: "error" as const, icon: stopped, why: step.errorText };
  }
  if (step.approval?.approved === false) return { word: "Refused", icon: stopped, why: step.approval.reason };
  if (step.state === "output-available" && !step.preliminary) {
    return { word: "Done", icon: <CheckIcon aria-hidden="true" /> };
  }
  // A step that was under way when the turn stopped is neither: it stopped there.
  if (!live) return { word: "Stopped", icon: stopped };
  return { word: "Under way", status: "running" as const, icon: <Spinner aria-hidden="true" /> };
}

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
    case "describe":
      return "Read the company's description";
    case "get_run":
      return `Read the run ${String(input.runId ?? "")}`;
    case "wait_run":
      return `Waited for the run ${String(input.runId ?? "")}`;
    case "drift":
      return "Checked for drift";
    case "start_run":
      return `Started ${String(input.workflow ?? "")}`;
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

/** A reply's suggested asks (`suggestionsOf`), each a button that sends it (`onAsk`). */
export function Suggested({ asks, onAsk }: { asks: string[]; onAsk: (ask: string) => void }) {
  return (
    <ul aria-label="Suggested asks" className="flex flex-col gap-2">
      {asks.map((ask) => (
        <li key={ask}>
          <Button
            variant="outline"
            className="h-auto w-full justify-start py-2 text-left whitespace-normal"
            onClick={() => onAsk(ask)}
          >
            {ask}
          </Button>
        </li>
      ))}
    </ul>
  );
}
