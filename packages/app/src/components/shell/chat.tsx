import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Button } from "#/components/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "#/components/ui/empty.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { useCrumbs } from "../common.tsx";

// The chat column, beside the bar on the same surface: where the agent will talk with you. Until
// the agent exists it says so, over a composer that cannot send yet.

/**
 * The chat column (`#chat`, which the bar's Chat controls): an empty state, and at its foot the
 * composer, carrying the page you are on as a chip. In the page's flow from `lg` up; between `md`
 * and `lg`, over the page beside the bar; not on a phone.
 */
export function ChatColumn() {
  return (
    <aside
      id="chat"
      aria-label="Chat"
      className="hidden h-svh w-(--chat-width) shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:fixed md:inset-y-0 md:left-(--bar-width) md:z-20 md:flex md:shadow-lg lg:sticky lg:top-0 lg:self-start lg:shadow-none"
    >
      <Empty className="p-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SparkleIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-display text-2xl font-normal">What should change?</EmptyTitle>
          <EmptyDescription>
            The agent is coming: you will ask it here, and it will draft changes for approval.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div className="p-3">
        <Composer />
      </div>
    </aside>
  );
}

/** The composer: the page as a chip, the message, Send. Disabled until the agent exists. */
function Composer() {
  const page = useCrumbs().at(-1)?.label;
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card p-3 text-card-foreground ring-1 ring-border">
      {page && (
        <span className="inline-flex h-6 w-fit max-w-full items-center rounded-md px-2 text-xs font-medium ring-1 ring-border">
          <span className="truncate">{page}</span>
        </span>
      )}
      <Textarea
        disabled
        rows={1}
        aria-label="Message the agent"
        placeholder="Ask anything…"
        className="min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
      />
      <div className="flex justify-end">
        <Button size="icon-sm" variant="secondary" disabled aria-label="Send">
          <ArrowUpIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
