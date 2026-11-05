import { useChat } from "@ai-sdk/react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { generateId } from "ai";
import { useMemo, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { cn } from "#/lib/utils.ts";
import { actorHeaders, useActor } from "../../actor.ts";
import {
  type ChatMessage,
  chatTransport,
  ENGINE_NAMES,
  type EngineName,
  MODEL_CONNECTOR,
  onModelConnector,
} from "../../lib/chat.ts";
import { CHATS_KEY, chatModelQuery, chatQuery, chatsQuery, configQuery } from "../../queries.ts";
import { useCrumbs } from "../common.tsx";
import type { Prompt } from "./chat-prompt.ts";
import { Composer } from "./composer.tsx";
import { ConnectorPageLink, isBusy, Thread } from "./thread.tsx";

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
    // A reply's Markdown is parsed again per update: at most 20 a second, however fast it streams.
    throttle: 50,
    // Its title in the list (the open transcript is useChat's own, read again when next opened).
    onFinish: () => void queryClient.invalidateQueries({ queryKey: CHATS_KEY, exact: true }),
    // A refused turn may be one the model's status here was too old to stop: read it again.
    onError: () => void queryClient.invalidateQueries({ queryKey: chatModelQuery().queryKey }),
  });
  const busy = isBusy(status);
  const page = useCrumbs().at(-1)?.label;
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
      <Thread
        chat={id}
        messages={messages}
        status={status}
        error={error}
        onContinue={noModel ? undefined : () => send("continue")}
      />
      <div className="p-3">
        <Composer
          page={page}
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
