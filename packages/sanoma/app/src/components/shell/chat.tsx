import { useChat } from "@ai-sdk/react";
import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { generateId } from "ai";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
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
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { cn } from "#/lib/utils.ts";
import { actorHeaders, useActor } from "../../actor.ts";
import {
  type ChatMessage,
  chatTransport,
  ENGINE_NAMES,
  type EngineName,
  errorParts,
  MODEL_CONNECTOR,
  onModelConnector,
  ownPlan,
  textOf,
  unfinished,
} from "../../lib/chat.ts";
import { CHATS_KEY, chatModelQuery, chatQuery, chatsQuery, configQuery } from "../../queries.ts";
import { useCrumbs } from "../common.tsx";
import { Reply } from "./chat-parts.tsx";
import type { Prompt } from "./chat-prompt.ts";

// The chat column, beside the bar on the same surface: the operator agent (POST /api/chat, its
// stream read by the AI SDK's useChat), your chats, and the composer carrying the page you are on.

/**
 * The chat column (`#chat`, which the bar's Chat controls): your latest chat (or the one you
 * pick, or a new one, or the new one a page's `prompt` opens with its text in the composer), and
 * at its foot the composer. In the page's flow from `lg` up; between `md` and `lg`, over the page
 * beside the bar (not while `besidePageOnly`, until Chat opens it there); not on a phone.
 */
export function ChatColumn({ besidePageOnly = false, prompt }: { besidePageOnly?: boolean; prompt?: Prompt }) {
  const { actor } = useActor();
  const { data: chats = [] } = useQuery({ ...chatsQuery(), enabled: !!actor });
  // A new chat's id is the browser's: the first message opens the chat by it.
  const [picked, setPicked] = useState(prompt?.id);
  const [fresh] = useState(generateId);
  const id = picked ?? chats[0]?.id ?? fresh;
  const chat = chats.find((c) => c.id === id);
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
            <span className="truncate">{chat?.title ?? "New chat"}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Your chats</DropdownMenuLabel>
              {chats.map((c) => (
                <DropdownMenuItem key={c.id} onClick={() => setPicked(c.id)}>
                  <span className="truncate">{c.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {chat && (
          <span className="shrink-0 text-xs text-muted-foreground" title="The engine answering this chat">
            {ENGINE_NAMES[chat.engine as EngineName] ?? chat.engine}
          </span>
        )}
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setPicked(generateId())}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          New chat
        </Button>
      </div>
      {/* Kept open once you write in it: a newer chat in the list does not take its place. */}
      <ChatPane
        key={id}
        id={id}
        known={chat !== undefined}
        draft={id === prompt?.id ? prompt.text : undefined}
        onSend={() => setPicked(id)}
      />
    </aside>
  );
}

/**
 * A chat: its transcript as stored when it is one you have had (as it was when opened, so the
 * first message of a new one does not read it back), then the conversation over it; a new one's
 * composer holds `draft`.
 */
function ChatPane({ id, known, draft, onSend }: { id: string; known: boolean; draft?: string; onSend: () => void }) {
  const [stored] = useState(known);
  const { data, error } = useQuery({ ...chatQuery(id), enabled: stored });
  if (!stored) return <Conversation id={id} initial={[]} draft={draft} onSend={onSend} />;
  if (error) return <p className="p-4 text-destructive">Could not read the chat: {error.message}</p>;
  if (data === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return <Conversation id={id} initial={data?.messages ?? []} openedOn={data?.chat.engine} onSend={onSend} />;
}

/**
 * The conversation: its messages, a turn's error, Continue after a turn that stopped short, and
 * the composer (holding `draft`), which says "Connect a model" (and Continue is not offered) while
 * the chat's engine (its own, `openedOn`, else the one chosen for a new chat) needs the model
 * connector and it has no key.
 */
function Conversation({
  id,
  initial,
  draft,
  openedOn,
  onSend,
}: {
  id: string;
  initial: ChatMessage[];
  draft?: string;
  openedOn?: string;
  onSend: () => void;
}) {
  const queryClient = useQueryClient();
  const transport = useMemo(() => chatTransport("/api/chat", actorHeaders), []);
  const { messages, sendMessage, status, error } = useChat<ChatMessage>({
    id,
    messages: initial,
    transport,
    // Its title in the list (the open transcript is useChat's own, read again when next opened).
    onFinish: () => void queryClient.invalidateQueries({ queryKey: CHATS_KEY, exact: true }),
    // A refused turn may be one the model's status here was too old to stop: read it again.
    onError: () => void queryClient.invalidateQueries({ queryKey: chatModelQuery().queryKey }),
  });
  const busy = status === "submitted" || status === "streaming";
  // The chat's own engine; a new chat opens on the one chosen in the composer and keeps it after.
  const [engine, setEngine] = useState<EngineName>(() => (openedOn as EngineName | undefined) ?? "loop");
  const fresh = messages.length === 0;
  const { data: model } = useQuery(chatModelQuery());
  const noModel = model?.ready === false && onModelConnector(engine);
  const send = (text: string) => {
    onSend();
    // Every message names it: the server opens a new chat on it (one whose first send failed, too)
    // and keeps an open chat's own.
    void sendMessage({ text }, { body: { engine } });
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && <EmptyChat />}
        {messages.map((message, i) =>
          message.role === "user" ? (
            <div key={message.id} className="ml-8 self-end rounded-xl bg-card px-3 py-2 ring-1 ring-border">
              <p className="whitespace-pre-wrap">{textOf(message, "\n")}</p>
            </div>
          ) : (
            <Reply key={message.id} message={message} live={busy && i === messages.length - 1} chat={id} />
          ),
        )}
        {status === "submitted" && <Spinner aria-label="Waiting for the agent" />}
        {error && <TurnError message={error.message} />}
        {!busy && !error && !noModel && stoppedShort(messages) && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>The last turn stopped before it finished.</span>
            <Button variant="secondary" size="sm" onClick={() => send("continue")}>
              Continue
            </Button>
          </div>
        )}
      </div>
      <div className="p-3">
        <Composer
          busy={busy}
          onSend={send}
          draft={draft}
          engine={fresh && !openedOn ? { value: engine, set: setEngine } : undefined}
          note={noModel ? <ConnectModel vendor={model?.vendor} /> : undefined}
        />
      </div>
    </>
  );
}

/** A turn that stopped before it finished (a restart, say): no reply to the last message, or a step or text still under way. */
function stoppedShort(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  if (!last) return false;
  return last.role === "user" || last.parts.some(unfinished);
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
          <ConnectorPageLink vendor={vendor}>Set it on its connector page</ConnectorPageLink>.
        </>
      )}
    </p>
  );
}

/** Focuses a text box with its caret after its text: where a prompt's words go on. */
const focusAtEnd = (box: HTMLTextAreaElement | null) => {
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
};

/** The engines, the composer's choices: ours on the company's key, then a person's own (`ownPlan`). */
const NAMES = Object.keys(ENGINE_NAMES) as EngineName[];
const OURS = NAMES.filter((name) => !ownPlan(name));
const OWN = NAMES.filter(ownPlan);

/** An engine as the composer's choice. */
const engineOption = (name: EngineName) => (
  <NativeSelectOption key={name} value={name}>
    {ENGINE_NAMES[name]}
  </NativeSelectOption>
);

/** A link to a connector's page, where its credentials are set. */
const ConnectorPageLink = ({ vendor, children }: { vendor: string; children: ReactNode }) => (
  <Link to="/connectors/$vendor" params={{ vendor }} className="underline underline-offset-4">
    {children}
  </Link>
);

/** The composer's note while the chat has no model: where to set its connector's key, or to add one (its sheet on the Connectors page). */
function ConnectModel({ vendor }: { vendor?: string }) {
  const { data: title } = useQuery({ ...configQuery(), select: (config) => vendor && config.vendors[vendor]?.title });
  return (
    <p className="text-muted-foreground">
      Connect a model to start:{" "}
      {vendor ? (
        <ConnectorPageLink vendor={vendor}>set its key on the {title ?? vendor} connector page</ConnectorPageLink>
      ) : (
        <Link to="/connectors" search={{ add: MODEL_CONNECTOR }} className="underline underline-offset-4">
          add the Anthropic connector
        </Link>
      )}
      .
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

/**
 * The composer: the page as a chip, the message (starting as `draft`, focused at its end, when a
 * page opened the chat with it), the engine a new chat opens on (`engine`, only then: a person's
 * own agents in a group of their own), Send (Enter; Shift+Enter for a new line), and while there
 * is a `note` (where to connect a model), the note, Send off.
 */
function Composer({
  busy,
  onSend,
  draft,
  engine,
  note,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  draft?: string;
  engine?: { value: EngineName; set: (engine: EngineName) => void };
  note?: ReactNode;
}) {
  const page = useCrumbs().at(-1)?.label;
  const [text, setText] = useState(draft ?? "");
  const noteId = useId();

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || note || !text.trim()) return;
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
        ref={draft ? focusAtEnd : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
        }}
        aria-label="Message the agent"
        placeholder="Ask anything…"
        className="min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      {note && <div id={noteId}>{note}</div>}
      <div className="flex items-center justify-end gap-2">
        {engine && (
          <NativeSelect
            size="sm"
            className="mr-auto"
            aria-label="Engine"
            value={engine.value}
            onChange={(e) => engine.set(e.target.value as EngineName)}
          >
            {OURS.map(engineOption)}
            <NativeSelectOptGroup label="Your own plan">{OWN.map(engineOption)}</NativeSelectOptGroup>
          </NativeSelect>
        )}
        <Button
          type="submit"
          size="icon-sm"
          variant="secondary"
          disabled={busy || !!note || !text.trim()}
          aria-label="Send"
          aria-describedby={note ? noteId : undefined}
        >
          {busy ? <Spinner /> : <ArrowUpIcon aria-hidden="true" />}
        </Button>
      </div>
    </form>
  );
}
