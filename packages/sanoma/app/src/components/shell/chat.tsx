import { useChat } from "@ai-sdk/react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { generateId } from "ai";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
  engineOf,
  enginesHere,
  enginesOf,
  isBusy,
  isIntro,
  MODEL_CONNECTOR,
  onModelConnector,
  textOf,
} from "../../lib/chat.ts";
import { CHATS_KEY, chatModelQuery, chatQuery, chatsQuery, configQuery } from "../../queries.ts";
import { useCrumbs } from "../common.tsx";
import type { Prompt } from "./chat-prompt.ts";
import { Composer } from "./composer.tsx";
import { ConnectAgent } from "./connect-agent.tsx";
import { EngineMark } from "./engine-mark.tsx";
import { ConnectorPageLink, Thread } from "./thread.tsx";

// The chat column, beside the bar on the same surface: the operator agent (POST /api/chat, its
// stream read by the AI SDK's useChat), your chats, and the composer carrying the page you are on.

/** The engine a person's new chats open on (none until they choose one), and choosing it. */
interface EngineChoice {
  value?: string;
  set(engine: string): void;
}

/**
 * The chat column (`#chat`, which the bar's Chat controls): your latest chat (or the one you
 * pick, or a new one, or the new one a page's `prompt` opens with its text in the composer), and
 * at its foot the composer. In the page's flow from `lg` up; between `md` and `lg`, over the page
 * beside the bar (not while `besidePageOnly`, until Chat opens it there); not on a phone. A new
 * chat opens on `engine`, the person's choice.
 */
export function ChatColumn({
  besidePageOnly = false,
  prompt,
  engine,
}: {
  besidePageOnly?: boolean;
  prompt?: Prompt;
  engine: EngineChoice;
}) {
  const { actor } = useActor();
  const { data: chats = [], isSuccess } = useQuery({ ...chatsQuery(), enabled: !!actor });
  // A new chat's id is the browser's: the first message opens the chat by it.
  const [picked, setPicked] = useState(prompt?.id);
  const [fresh] = useState(generateId);
  const id = picked ?? chats[0]?.id ?? fresh;
  const chat = chats.find((c) => c.id === id);
  // Every engine of the company's, to label a chat by, even one it can no longer open on here.
  const { data: engines = [] } = useQuery({ ...configQuery(), select: (config) => enginesOf(config.agents) });
  const optionOf = (name: string) => engines.find((e) => e.name === name);
  const opened = chat && optionOf(chat.engine);
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
              {chats.map((c) => {
                const on = optionOf(c.engine);
                return (
                  <DropdownMenuItem key={c.id} onClick={() => setPicked(c.id)}>
                    {on && <EngineMark engine={on} />}
                    <span className="truncate">{c.title}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {chat && (
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
            title="The engine answering this chat"
          >
            {opened && <EngineMark engine={opened} />}
            {opened?.label ?? chat.engine}
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
        opening={id === prompt?.id ? prompt : undefined}
        first={isSuccess && !chats.length}
        engine={engine}
        onSend={() => setPicked(id)}
      />
    </aside>
  );
}

/** Whether a reply ends in a sign-in that finished: its card is `done`. */
const signedInBy = (message?: ChatMessage) =>
  message?.parts.some((part) => part.type === "data-signIn" && part.data.state === "done") === true;

/** What a conversation is opened with besides its chat:the prompt that opened it, whether it is the person's first, and the engine a new one opens on. */
interface Opened {
  opening?: Prompt;
  first?: boolean;
  engine: EngineChoice;
  onSend: () => void;
}

/**
 * A chat: its transcript as stored when it is one you have had (as it was when opened, so the
 * first message of a new one does not read it back), then the conversation over it; a new one
 * opens with the prompt that opened it (`opening`).
 */
function ChatPane({ id, known, ...opened }: { id: string; known: boolean } & Opened) {
  const [stored] = useState(known);
  const { data, error } = useQuery({ ...chatQuery(id), enabled: stored });
  if (!stored) return <Conversation id={id} initial={[]} {...opened} />;
  if (error) return <p className="p-4 text-destructive">Could not read the chat: {error.message}</p>;
  if (data === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <Conversation
      id={id}
      initial={data?.messages ?? []}
      openedOn={data?.chat.engine}
      engine={opened.engine}
      onSend={opened.onSend}
    />
  );
}

/**
 * The conversation on `useChat`: its `Thread`, and the composer (holding the opening prompt's
 * text), which says "Connect a model" (and Continue is not offered) while the chat's engine (its
 * own, `openedOn`, else the one chosen for a new chat) needs the model connector and it has no
 * key. A new chat's thread starts with the agents to connect while so (or when Agent… opened it);
 * and the agent speaks first in the person's first chat once its engine is connected, and when a
 * card chose a plan of their own. Once a sign-in the agent asked for is done, the person's last
 * message is sent again (in a chat they have not written in, the agent speaks first).
 */
function Conversation({
  id,
  initial,
  opening,
  first = false,
  openedOn,
  engine: choice,
  onSend,
}: { id: string; initial: ChatMessage[]; openedOn?: string } & Opened) {
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
  // The chat's own engine; a new chat opens on the person's choice (`choice`, which choosing here
  // changes) and keeps it after.
  // The person's choice is one cookie for every company on this computer: one this company cannot run here is not taken.
  const { data: options = [] } = useQuery({ ...configQuery(), select: enginesHere });
  const [chosen, setChosen] = useState<string>();
  const engine =
    openedOn ?? chosen ?? (options.some((option) => option.name === choice.value) ? choice.value! : "loop");
  const choose = (name: string) => {
    setChosen(name);
    choice.set(name);
  };
  const fresh = messages.length === 0;
  const { data: model } = useQuery(chatModelQuery());
  const noModel = model?.ready === false && onModelConnector(engine);
  const send = (text: string) => {
    onSend();
    // Every message names it: the server opens a new chat on it (one whose first send failed, too)
    // and keeps an open chat's own.
    void sendMessage({ text }, { body: { engine } });
  };
  /** The agent speaks first, on `on`: the message is its cue, which the server writes and the chat never shows. */
  const speak = (on: string) => {
    onSend();
    void sendMessage({ text: "", metadata: { intro: true } }, { body: { engine: on, start: true } });
  };
  const cards = fresh && !busy && !openedOn && (noModel || opening?.choose === true);
  const last = messages.at(-1);
  const lastId = last?.id ?? "";
  // The chat goes on by itself once each time the last message changes: the agent speaks first in
  // the person's first chat while it is in view (not one a page opened with a prompt), and after a
  // sign-in it asked for, the turn is asked again, unless the turn before it ended in a sign-in too
  // (a sign-in that does not hold would ask forever).
  const greet = first && fresh && !openedOn && !opening && model !== undefined && !cards;
  const signedIn = signedInBy(last) && !signedInBy(messages.at(-3));
  const cue = !busy && !error && (greet || signedIn);
  const acted = useRef<string>(undefined);
  const act = useEffectEvent(() => {
    if (greet && !document.getElementById("chat")?.checkVisibility()) return;
    acted.current = lastId;
    // The person's last message, which the sign-in's turn did not answer; in a chat they have not
    // written in, the agent's cue.
    const asked = messages.findLast((message) => message.role === "user" && !isIntro(message));
    if (asked) send(textOf(asked));
    else speak(engine);
  });
  useEffect(() => {
    if (cue && acted.current !== lastId) act();
  }, [cue, lastId]);
  return (
    <>
      <Thread
        chat={id}
        messages={messages}
        status={status}
        error={error}
        start={
          cards ? (
            <ConnectAgent
              vendor={model?.vendor}
              onChoose={(name) => {
                choose(name);
                if (engineOf(name).plan !== "own") return;
                // Spoken here, so the chat does not speak by itself as well.
                acted.current = lastId;
                speak(name);
              }}
            />
          ) : undefined
        }
        onSend={send}
        canContinue={!noModel}
      />
      <div className="p-3">
        <Composer
          page={page}
          busy={busy}
          onSend={send}
          draft={opening?.text}
          engine={fresh && !openedOn ? { value: engine, set: choose, options } : undefined}
          note={
            noModel ? (
              cards ? (
                <p className="text-muted-foreground">Connect your agent above to start.</p>
              ) : (
                <ConnectModel vendor={model?.vendor} />
              )
            ) : undefined
          }
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
