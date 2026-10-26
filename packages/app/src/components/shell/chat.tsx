import { useChat } from "@ai-sdk/react";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DefaultChatTransport, generateId, isToolUIPart } from "ai";
import { type FormEvent, useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { cn } from "#/lib/utils.ts";
import { loadActor, useActor } from "../../actor.ts";
import { ACTOR_HEADER } from "../../api.ts";
import { type ChatMessage, errorParts } from "../../lib/chat.ts";
import { CHATS_KEY, chatQuery, chatsQuery } from "../../queries.ts";
import { useCrumbs } from "../common.tsx";
import { Reply } from "./chat-parts.tsx";

// The chat column, beside the bar on the same surface: the operator agent (POST /api/chat, its
// stream read by the AI SDK's useChat), your chats, and the composer carrying the page you are on.

/**
 * The chat column (`#chat`, which the bar's Chat controls): your latest chat (or the one you
 * pick, or a new one), and at its foot the composer. In the page's flow from `lg` up; between `md`
 * and `lg`, over the page beside the bar (not while `besidePageOnly`, until Chat opens it there);
 * not on a phone.
 */
export function ChatColumn({ besidePageOnly = false }: { besidePageOnly?: boolean }) {
  const { actor } = useActor();
  const { data: chats = [] } = useQuery({ ...chatsQuery(), enabled: !!actor });
  // A new chat's id is the browser's: the first message opens the chat by it.
  const [picked, setPicked] = useState<string>();
  const [fresh] = useState(generateId);
  const id = picked ?? chats[0]?.id ?? fresh;
  const known = chats.some((chat) => chat.id === id);
  return (
    <aside
      id="chat"
      aria-label="Chat"
      className={cn(
        "hidden h-svh w-(--chat-width) shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:fixed md:inset-y-0 md:left-(--bar-width) md:z-20 md:shadow-lg lg:sticky lg:top-0 lg:flex lg:self-start lg:shadow-none",
        !besidePageOnly && "md:flex",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm" className="min-w-0" disabled={!chats.length} />}
          >
            <ChatCircleIcon aria-hidden="true" data-icon="inline-start" />
            <span className="truncate">{chats.find((chat) => chat.id === id)?.title ?? "New chat"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Your chats</DropdownMenuLabel>
              {chats.map((chat) => (
                <DropdownMenuItem key={chat.id} onClick={() => setPicked(chat.id)}>
                  <span className="truncate">{chat.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={() => setPicked(generateId())}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          New chat
        </Button>
      </div>
      {/* Kept open once you write in it: a newer chat in the list does not take its place. */}
      <ChatPane key={id} id={id} known={known} onSend={() => setPicked(id)} />
    </aside>
  );
}

/**
 * A chat: its transcript as stored when it is one you have had (as it was when opened, so the
 * first message of a new one does not read it back), then the conversation over it.
 */
function ChatPane({ id, known, onSend }: { id: string; known: boolean; onSend: () => void }) {
  const [stored] = useState(known);
  const { data, error } = useQuery({ ...chatQuery(id), enabled: stored });
  if (!stored) return <Conversation id={id} initial={[]} onSend={onSend} />;
  if (error) return <p className="p-4 text-destructive">Could not read the chat: {error.message}</p>;
  if (data === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <Conversation id={id} initial={data?.messages ?? []} onSend={onSend} />;
}

/** The conversation: its messages, a turn's error, Continue after a turn that stopped short, and the composer. */
function Conversation({ id, initial, onSend }: { id: string; initial: ChatMessage[]; onSend: () => void }) {
  const queryClient = useQueryClient();
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatMessage>({
        api: "/api/chat",
        headers: (): Record<string, string> => {
          const name = loadActor();
          return name ? { [ACTOR_HEADER]: encodeURIComponent(name) } : {};
        },
        // Only the new message: the server reads the rest from the chat's transcript.
        prepareSendMessagesRequest: (request) => ({ body: { id: request.id, message: request.messages.at(-1) } }),
      }),
    [],
  );
  const { messages, sendMessage, status, error } = useChat<ChatMessage>({
    id,
    messages: initial,
    transport,
    // Its title in the list, and its transcript as stored now.
    onFinish: () => void queryClient.invalidateQueries({ queryKey: CHATS_KEY }),
  });
  const busy = status === "submitted" || status === "streaming";
  const send = (text: string) => {
    onSend();
    void sendMessage({ text });
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && <EmptyChat />}
        {messages.map((message, i) =>
          message.role === "user" ? (
            <div key={message.id} className="ml-8 self-end rounded-xl bg-card px-3 py-2 ring-1 ring-border">
              <p className="whitespace-pre-wrap">
                {message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")}
              </p>
            </div>
          ) : (
            <Reply key={message.id} message={message} live={busy && i === messages.length - 1} />
          ),
        )}
        {status === "submitted" && <Spinner aria-label="Waiting for the agent" />}
        {error && <TurnError message={error.message} />}
        {!busy && !error && stoppedShort(messages) && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>The last turn stopped before it finished.</span>
            <Button variant="secondary" size="sm" onClick={() => send("continue")}>
              Continue
            </Button>
          </div>
        )}
      </div>
      <div className="p-3">
        <Composer busy={busy} onSend={send} />
      </div>
    </>
  );
}

/** A turn that stopped before it finished (a restart, say): no reply to the last message, or a step or text still under way. */
function stoppedShort(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "user") return true;
  return last.parts.some((part) =>
    isToolUIPart(part)
      ? part.state === "input-streaming" ||
        part.state === "input-available" ||
        (part.state === "output-available" && part.preliminary === true)
      : part.type === "text" && part.state === "streaming",
  );
}

/** A turn's error as text: the server's own message when it sent one, and the connector page where a missing key is set. */
function TurnError({ message }: { message: string }) {
  let said = message;
  try {
    said = (JSON.parse(message) as { error?: string }).error ?? message;
  } catch {
    // Not the app's JSON error: the text as it came.
  }
  const { text, vendor } = errorParts(said);
  return (
    <p className="text-destructive">
      {text}
      {vendor && (
        <>
          {" "}
          <Link to="/connectors/$vendor" params={{ vendor }} className="underline underline-offset-4">
            Set it on its connector page
          </Link>
          .
        </>
      )}
    </p>
  );
}

function EmptyChat() {
  return (
    <Empty className="p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SparkleIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="font-display text-2xl font-normal">What should change?</EmptyTitle>
        <EmptyDescription>
          Ask the agent: it drafts the change on a branch of its own and checks it. You merge it.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The composer: the page as a chip, the message, Send (Enter; Shift+Enter for a new line). */
function Composer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const page = useCrumbs().at(-1)?.label;
  const [text, setText] = useState("");
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-border"
    >
      {page && (
        <span className="inline-flex h-6 w-fit max-w-full items-center rounded-md px-2 text-xs font-medium ring-1 ring-border">
          <span className="truncate">{page}</span>
        </span>
      )}
      <Textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
        }}
        aria-label="Message the agent"
        placeholder="Ask anything…"
        className="min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex justify-end">
        <Button type="submit" size="icon-sm" variant="secondary" disabled={busy || !text.trim()} aria-label="Send">
          {busy ? <Spinner /> : <ArrowUpIcon aria-hidden="true" />}
        </Button>
      </div>
    </form>
  );
}
