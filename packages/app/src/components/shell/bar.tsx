import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link } from "@tanstack/react-router";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { Fragment, type ReactNode, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "#/components/ui/sheet.tsx";
import { useSites } from "#/lib/sites.ts";
import type { Tone } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import type { AppConfig, Place } from "../../api.ts";
import { configQuery, pendingOf, waitingRunsQuery } from "../../queries.ts";
import { Tip, toneBadge } from "../kit.tsx";
import { NavUser } from "./nav-user.tsx";

// The bar: Chat, then the app's sections in groups, then who you are. A section is a page; there
// is nothing beside the bar but the chat column.

/** A section in the bar: its page, lit there and on the pages under it (a site's, for Sites). */
type Section = { to: string; label: string; icon: PhosphorIcon; when?: "sites" | "data" | "policy" };

/** The sections, in groups split by a short rule: what happens, what the company built, how it is set up. */
const GROUPS: Section[][] = [
  [
    { to: "/inbox", label: "Inbox", icon: TrayIcon },
    { to: "/workflows", label: "Workflows", icon: TreeStructureIcon },
  ],
  [
    { to: "/sites", label: "Sites", icon: BrowserIcon, when: "sites" },
    { to: "/data", label: "Data", icon: TableIcon, when: "data" },
  ],
  [
    { to: "/resources", label: "Resources", icon: CubeIcon },
    { to: "/connectors", label: "Connectors", icon: PlugIcon },
    { to: "/permissions", label: "Permissions", icon: KeyIcon, when: "policy" },
    { to: "/setup", label: "Go live", icon: RocketIcon },
  ],
];

/** What the bar reads from the config: whether it has collections and a policy. */
const selectBar = (config: ConfigDescription) => ({
  data: config.collections.length > 0,
  policy: config.policy.defined,
});

/**
 * An item of the bar: its icon in a tile, its label under it; the tile filled while it is current
 * (`data-active`: a section's page or one under it, Chat while its column is open).
 */
const ITEM =
  "group/item relative flex w-full flex-col items-center gap-1 rounded-lg text-bar text-sidebar-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:font-medium";
const TILE =
  "flex size-9 items-center justify-center rounded-lg transition-colors group-hover/item:bg-secondary/60 group-data-active/item:bg-secondary [&_svg]:size-5";

/** A section's link lit while its page, or one under it, shows (Link sets `aria-current` too). */
const ACTIVE = { "data-active": true } as const;

/**
 * The bar, on the `sidebar` surface: Chat, which folds and unfolds the chat column (`chat`; left
 * out in the phone's sheet, which has no column), the sections (Sites, Data and Permissions only
 * when there are sites, collections or policies), and at its foot what the open window is
 * (`PlaceBadge`) above the user menu.
 */
export function Bar({ chat, className }: { chat?: { open: boolean; toggle: () => void }; className?: string }) {
  const { data: has } = useSuspenseQuery({ ...configQuery(), select: selectBar });
  const shown = { sites: useSites().length > 0, data: has.data, policy: has.policy };
  const groups = GROUPS.map((group) => group.filter((section) => !section.when || shown[section.when])).filter(
    (group) => group.length > 0,
  );
  return (
    <div
      className={cn(
        "flex w-(--bar-width) shrink-0 flex-col items-center gap-1.5 bg-sidebar px-1 py-2.5 text-sidebar-foreground",
        className,
      )}
    >
      {chat && (
        <>
          <button
            type="button"
            aria-expanded={chat.open}
            // The column is not there while folded.
            aria-controls={chat.open ? "chat" : undefined}
            data-active={chat.open || undefined}
            onClick={chat.toggle}
            className={ITEM}
          >
            <span className={TILE}>
              <SparkleIcon aria-hidden="true" />
            </span>
            Chat
          </button>
          <Rule />
        </>
      )}
      <nav aria-label="Sections" className="flex w-full flex-col items-center gap-1.5">
        {groups.map((group, i) => (
          <Fragment key={group[0]!.label}>
            {i > 0 && <Rule />}
            <ul className="flex w-full flex-col gap-1.5">
              {group.map((section) => (
                <li key={section.label}>
                  <Link to={section.to} activeProps={ACTIVE} className={ITEM}>
                    <Item section={section}>{section.to === "/inbox" && <InboxCount />}</Item>
                  </Link>
                </li>
              ))}
            </ul>
          </Fragment>
        ))}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-2">
        <PlaceBadge />
        <NavUser />
      </div>
    </div>
  );
}

/** An item's tile, holding its icon and `children` (a badge), and its label. */
function Item({ section: { icon: Icon, label }, children }: { section: Section; children?: ReactNode }) {
  return (
    <>
      <span className={cn(TILE, "relative")}>
        <Icon aria-hidden="true" />
        {children}
      </span>
      {label}
    </>
  );
}

/** The short rule between the bar's groups. */
function Rule() {
  return <div aria-hidden="true" className="my-1 h-px w-9 shrink-0 bg-border" />;
}

/** What the badge reads from the config: where this instance is. */
const selectPlace = ({ place, databaseHost }: AppConfig) => ({ place, databaseHost });

/** Each place's badge: its words and its tone. */
const PLACES: Record<Place, { label: string; tone: Tone }> = {
  "this-computer": { label: "This computer", tone: "idle" },
  live: { label: "Live", tone: "ok" },
};

/**
 * What the open window is, from what this instance connects to (`placeOf`): This computer or
 * Live, its tip the database's host and nothing more (the default socket's is none, an unreadable URL's unknown).
 */
function PlaceBadge() {
  const { data } = useSuspenseQuery({ ...configQuery(), select: selectPlace });
  const { label, tone } = PLACES[data.place];
  return (
    <Tip
      tip={
        data.databaseHost === undefined
          ? "Database host unknown"
          : `Database on ${data.databaseHost || "a local socket"}`
      }
    >
      <Badge
        tabIndex={0}
        className={cn(toneBadge({ tone }), "h-auto max-w-full rounded-md text-center text-bar whitespace-normal")}
      >
        {label}
      </Badge>
    </Tip>
  );
}

/**
 * How many approvals wait, on Inbox's tile. The Inbox page's query (its costliest read), polled
 * every 30 s for the badge. Each watcher polls at its own interval, so while the Inbox page shows,
 * its 5 s poll keeps the badge fresh too; and a decision refreshes it at once. After hydration
 * only: the root loader starts this query without waiting for it, so the server may render before
 * it answers and the browser after.
 */
function InboxCount() {
  const { data: pending } = useQuery({
    ...waitingRunsQuery(),
    refetchInterval: 30_000,
    select: (runs) => pendingOf(runs).length,
  });
  return (
    <ClientOnly>
      {!!pending && (
        <Badge
          className={cn(
            toneBadge({ tone: "waiting" }),
            "absolute -top-1 -right-1.5 h-4 min-w-4 px-1 text-bar tabular-nums",
          )}
        >
          {pending}
          <span className="sr-only"> waiting</span>
        </Badge>
      )}
    </ClientOnly>
  );
}

/**
 * On a phone, in the bar's place: a row atop the page with a menu button, which opens the bar in a
 * sheet from the left, closed again as you follow a link in it or tap beside it.
 */
export function PhoneBar() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex h-12 items-center border-b px-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Menu" />}>
          <ListIcon aria-hidden="true" />
        </SheetTrigger>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="gap-0 bg-sidebar data-[side=left]:w-auto"
          onClick={(event) => {
            if ((event.target as Element).closest("a")) setOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Sections</SheetTitle>
          <Bar className="h-full" />
        </SheetContent>
      </Sheet>
    </div>
  );
}
