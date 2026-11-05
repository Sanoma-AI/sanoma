import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Link } from "@tanstack/react-router";
import type { ChatStatus } from "ai";
import { memo, type ReactNode } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Bubble, BubbleContent } from "#/components/ui/bubble.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";
import { Marker, MarkerContent } from "#/components/ui/marker.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "#/components/ui/message-scroller.tsx";
import { Trace, TraceLine, TraceTitle } from "#/components/ui/trace.tsx";
import { type ChatMessage, errorParts, textOf, unfinished } from "../../lib/chat.ts";
import { Reply } from "./chat-parts.tsx";

// The chat's thread, given its messages and status: off `common.tsx` and `useChat`, so a test draws
// it on a scripted conversation.

/** Whether a turn is under way. */
export const isBusy = (status: ChatStatus) => status === "submitted" || status === "streaming";

/**
 * The thread (AI Elements' Chat): each turn an item of the scroller, the person's the anchor, so
 * a new question settles near the top with the reply streaming below it; then what waits on the
 * turn, its error, and Continue (`onContinue`, when it can be offered) after one that stopped short.
 */
export function Thread({
  chat,
  messages,
  status,
  error,
  onContinue,
}: {
  chat: string;
  messages: ChatMessage[];
  status: ChatStatus;
  error?: Error;
  onContinue?: () => void;
}) {
  const busy = isBusy(status);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className="h-auto min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Conversation">
          <MessageScrollerContent className="gap-4 p-4">
            {messages.length === 0 && (
              <MessageScrollerItem className="flex flex-1 flex-col">
                <EmptyChat />
              </MessageScrollerItem>
            )}
            {messages.map((message, i) => (
              <Turn key={message.id} message={message} live={busy && i === messages.length - 1} chat={chat} />
            ))}
            {status === "submitted" && (
              <MessageScrollerItem>
                <Trace>
                  <TraceLine status="running" className="text-xs">
                    <TraceTitle>Waiting for the agent</TraceTitle>
                  </TraceLine>
                </Trace>
              </MessageScrollerItem>
            )}
            {error && (
              <MessageScrollerItem>
                <TurnError message={error.message} />
              </MessageScrollerItem>
            )}
            {!busy && !error && onContinue && stoppedShort(messages) && (
              <MessageScrollerItem>
                <Marker>
                  <MarkerContent>The last turn stopped before it finished.</MarkerContent>
                  <Button variant="secondary" size="sm" onClick={onContinue}>
                    Continue
                  </Button>
                </Marker>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * A turn, an item of the scroller: the person's in a bubble, and the anchor; else the agent's reply.
 * Memoized: a streamed chunk redraws only the turn it belongs to.
 */
const Turn = memo(function Turn({ message, live, chat }: { message: ChatMessage; live: boolean; chat: string }) {
  return (
    <MessageScrollerItem messageId={message.id} scrollAnchor={message.role === "user"}>
      {message.role === "user" ? (
        <Message align="end">
          <MessageContent>
            <Bubble align="end" variant="outline">
              <BubbleContent className="whitespace-pre-wrap">{textOf(message, "\n")}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      ) : (
        <Reply message={message} live={live} chat={chat} />
      )}
    </MessageScrollerItem>
  );
});

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
    <Alert variant="destructive">
      <AlertDescription>
        {text}
        {vendor && (
          <>
            {" "}
            <ConnectorPageLink vendor={vendor}>Set it on its connector page</ConnectorPageLink>.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A link to a connector's page, where its credentials are set. */
export const ConnectorPageLink = ({ vendor, children }: { vendor: string; children: ReactNode }) => (
  <Link to="/connectors/$vendor" params={{ vendor }} className="underline underline-offset-4">
    {children}
  </Link>
);

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
