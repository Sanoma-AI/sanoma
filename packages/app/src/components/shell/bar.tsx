import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link } from "@tanstack/react-router";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { Fragment, type ReactNode, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "#/components/ui/sheet.tsx";
import { type Site, useSites } from "#/lib/sites.ts";
import type { Tone } from "#/lib/tone.ts";
import { cn } from "#/lib/utils.ts";
import type { AppConfig, Place } from "../../api.ts";
import { configQuery, pendingOf, waitingRunsQuery } from "../../queries.ts";
import { Tip, toneBadge } from "../kit.tsx";
import { SiteIcon } from "../site-icon.tsx";
import { NavUser } from "./nav-user.tsx";

// The bar: Chat, then Sanoma's own pages, the company's sites and how it is set up, in groups,
// then who you are. Each item is a page; there is nothing beside the bar but the chat column.

/** An item in the bar: its page, lit there and on the pages under it, shown only `when` the config has those. */
type Section = { to: string; label: string; icon: PhosphorIcon; when?: "data" | "policy" };

/** What happens, across the company's apps: Sanoma's own pages. */
const WORK: Section[] = [
  { to: "/inbox", label: "Inbox", icon: TrayIcon },
  { to: "/workflows", label: "Workflows", icon: TreeStructureIcon },
];

/** How the company is set up. Data's page leads to the Sites page too. */
const SETUP: Section[] = [
  { to: "/data", label: "Data", icon: TableIcon, when: "data" },
  { to: "/resources", label: "Resources", icon: CubeIcon },
  { to: "/connectors", label: "Connectors", icon: PlugIcon },
  { to: "/apps", label: "Apps", icon: SquaresFourIcon },
  { to: "/permissions", label: "Permissions", icon: KeyIcon, when: "policy" },
  { to: "/setup", label: "Go live", icon: RocketIcon },
];

/** What the bar reads from the config: whether it has collections and a policy, and which sites are public. */
const selectBar = (config: ConfigDescription) => ({
  data: config.collections.length > 0,
  policy: config.policy.defined,
  public: new Set(config.sites.filter((site) => site.public).map((site) => site.name)),
});

/** A tile of the bar: its link, label and icon. */
type Tile = { to: string; label: string; icon: ReactNode };

/** A section's tile. */
const section = ({ icon: Icon, ...rest }: Section): Tile => ({ ...rest, icon: <Icon aria-hidden="true" /> });

/** A site's tile: to its first page (its home, when it has one), lit there and on the pages under it. */
const siteTile = ({ title, icon, pages }: Site, isPublic: boolean): Tile => ({
  to: pages[0]!.to,
  label: title,
  icon: <SiteIcon icon={icon} public={isPublic} />,
});

/**
 * The bar's groups, split by a short rule: Inbox and Workflows; the company's sites, a group for
 * the root's and then one for each app's, by the app's name (a site with no page it can link to
 * left out); then Setup. Data shows with collections, or with sites, its page leading to theirs;
 * Permissions with a policy.
 */
function useGroups(): Tile[][] {
  const { data: has } = useSuspenseQuery({ ...configQuery(), select: selectBar });
  const sites = useSites();
  const shown = { data: has.data || sites.length > 0, policy: has.policy };
  // By code unit, the same on the server and in any browser: the root's ("") first.
  const byApp = Map.groupBy(
    sites.filter((site) => site.pages.length > 0),
    (site) => site.app ?? "",
  );
  return [
    WORK.map(section),
    ...[...byApp.keys()]
      .toSorted()
      .map((app) => byApp.get(app)!.map((site) => siteTile(site, has.public.has(site.name)))),
    SETUP.filter((item) => !item.when || shown[item.when]).map(section),
  ];
}

/**
 * An item of the bar: its icon in a tile, its label under it; the tile filled while it is current
 * (`data-active`: a section's page or one under it, Chat while its column is open).
 */
const ITEM =
  "group/item relative flex w-full flex-col items-center gap-1 rounded-lg text-center text-bar wrap-break-word text-sidebar-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:font-medium";
const TILE =
  "flex size-9 items-center justify-center rounded-lg transition-colors group-hover/item:bg-secondary/60 group-data-active/item:bg-secondary [&_svg]:size-5";

/** A section's link lit while its page, or one under it, shows (Link sets `aria-current` too). */
const ACTIVE = { "data-active": true } as const;

/**
 * The bar, on the `sidebar` surface: Chat, which folds and unfolds the chat column (`chat`; left
 * out in the phone's sheet, which has no column), the groups (`useGroups`), and at its foot what
 * the open window is (`PlaceBadge`) above the user menu.
 */
export function Bar({ chat, className }: { chat?: { open: boolean; toggle: () => void }; className?: string }) {
  const groups = useGroups();
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
          <Fragment key={group[0]!.to}>
            {i > 0 && <Rule />}
            <ul className="flex w-full flex-col gap-1.5">
              {group.map(({ to, label, icon }) => (
                <li key={to}>
                  <Link to={to} activeProps={ACTIVE} className={ITEM}>
                    <span className={cn(TILE, "relative")}>
                      {icon}
                      {to === "/inbox" && <InboxCount />}
                    </span>
                    {label}
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
