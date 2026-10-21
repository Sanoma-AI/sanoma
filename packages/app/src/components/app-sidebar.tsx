import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link } from "@tanstack/react-router";
import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { KeyIcon } from "@phosphor-icons/react/dist/csr/Key";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { type CSSProperties, type MouseEvent, type ReactNode, type RefObject, Suspense, useRef, useState } from "react";
import { NavUser } from "#/components/nav-user.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { PopoverTrigger } from "#/components/ui/popover.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { useSites } from "#/lib/sites.ts";
import { cn } from "#/lib/utils.ts";
import { configQuery, OVERVIEW, pendingOf, waitingRunsQuery } from "../queries.ts";
import { toneBadge } from "./common.tsx";
import { InboxPanel } from "./panels/inbox-panel.tsx";
import {
  ACTIVE,
  type Panel,
  PanelSkeleton,
  sectionOf,
  useHasPanel,
  usePageSection,
  usePanel,
} from "./panels/panel.tsx";
import { DataPanel } from "./panels/data-panel.tsx";
import { PermissionsPanel } from "./panels/permissions-panel.tsx";
import { SitesPanel } from "./panels/sites-panel.tsx";
import { WorkflowPanel } from "./panels/workflow-panel.tsx";
import { WorkflowsPanel } from "./panels/workflows-panel.tsx";

// The sidebar: a bar of the app's sections, and beside it the panel that lists the current one
// (shadcn's sidebar-09, two sidebars in one). Folded, the bar stays and its sections peek their panel.

/**
 * The bar's sections, and the panel each lists. (Each page's own name is its route's crumb; a
 * route names its section in `staticData.section`, which is typed from this list: so it is a
 * plain list, as `linkOptions` would type it from the routes.)
 */
const SECTIONS = [
  { to: "/inbox", label: "Inbox", icon: TrayIcon, panel: "inbox" },
  { to: "/workflows", label: "Workflows", icon: TreeStructureIcon, panel: "workflows" },
  { to: "/resources", label: "Resources", icon: CubeIcon, panel: undefined },
  { to: "/connectors", label: "Connectors", icon: PlugIcon, panel: undefined },
  { to: "/setup", label: "Go live", icon: RocketIcon, panel: undefined },
  // The company's sites, shown only when it has some: its link is the first site's home, which
  // only the build knows (`useSites`).
  { to: undefined, label: "Sites", icon: BrowserIcon, panel: "sites" },
  // The company's collections, shown only when it has some.
  { to: "/data", label: "Data", icon: TableIcon, panel: "data" },
  // What the policy answers each group, shown only when the config has a policy.
  { to: "/permissions", label: "Permissions", icon: KeyIcon, panel: "permissions" },
] as const satisfies readonly {
  to: string | undefined;
  label: string;
  icon: PhosphorIcon;
  panel: string | undefined;
}[];

type Section = (typeof SECTIONS)[number];

/** The sections with a panel. Resources, Connectors and Go live have none, until they have something to list. */
export type PanelSection = NonNullable<Section["panel"]>;

/** A section's label, by its panel: the peek's name. */
const LABEL = Object.fromEntries(SECTIONS.flatMap((s) => (s.panel ? [[s.panel, s.label]] : []))) as Record<
  PanelSection,
  string
>;

/**
 * SidebarProvider's `style`: the bar folded (`--sidebar-width-icon`), and open the bar and the
 * panel, or the bar alone in a section with no panel, so its page gets the room. The widths
 * themselves are style.css's `--sidebar-bar-width` and `--sidebar-panel-width`.
 */
const BAR_AND_PANEL = {
  "--sidebar-width-icon": "var(--sidebar-bar-width)",
  "--sidebar-width": "calc(var(--sidebar-bar-width) + var(--sidebar-panel-width))",
} as CSSProperties;
const BAR_ALONE = {
  "--sidebar-width-icon": "var(--sidebar-bar-width)",
  "--sidebar-width": "var(--sidebar-bar-width)",
} as CSSProperties;

/** The sidebar's widths, for SidebarProvider's `style`: the same object until the page's section gains or loses a panel. */
export const useSidebarWidths = () => (useHasPanel() ? BAR_AND_PANEL : BAR_ALONE);

/** A section in the bar: its icon, its label under it, lit while its page or one under it shows. */
const BAR_ITEM =
  "relative flex flex-col items-center gap-1 rounded-md px-0.5 py-2 text-[11px] leading-none text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-popup-open:bg-sidebar-accent [&_svg]:size-5 [&_svg]:shrink-0";

/** Whether a click landed on a link, and so is followed: for one handler over a whole panel. */
const onLink = (event: MouseEvent) => (event.target as Element).closest("a") !== null;

/**
 * The sidebar: the section bar, and beside it the current section's panel (`usePanel`), docked
 * while the sidebar is open (SidebarProvider's state, kept in its cookie). Otherwise each section
 * with a panel peeks it over the page, as the pointer rests on it or the keyboard focuses it. On
 * a phone the sidebar is a sheet holding both.
 */
export function AppSidebar() {
  const { open, isMobile, setOpenMobile } = useSidebar();
  const panel = usePanel();
  const docked = !isMobile && open && panel !== undefined;
  // The phone's sheet is its only way around: in a section with no panel, it lists the workflows.
  const shown = isMobile ? (panel ?? ({ kind: "workflows" } as const)) : docked ? panel : undefined;
  const bar = useRef<HTMLDivElement>(null);
  // One peek for every section, so moving between sections swaps what it shows.
  const [peek] = useState(() => PopoverPrimitive.createHandle<PanelSection>());
  const peeking = !isMobile && !docked;
  return (
    <Sidebar collapsible="icon" className="overflow-hidden">
      {/* Bar and panel side by side, in the sheet on a phone too. A link followed in them closes
          the sheet, and the peek a section's link opened. */}
      <div
        className="flex min-h-0 flex-1"
        onClick={(event) => {
          if (!onLink(event)) return;
          setOpenMobile(false);
          peek.close();
        }}
      >
        <SectionBar ref={bar} peek={peeking ? peek : undefined} />
        {shown && (
          <Sidebar collapsible="none" className="w-auto min-w-0 flex-1 md:w-(--sidebar-panel-width) md:flex-none">
            <Suspense fallback={<PanelSkeleton />}>
              <PanelView panel={shown} />
            </Suspense>
          </Sidebar>
        )}
      </div>
      {panel && <SidebarRail />}
      {peeking && <Peek handle={peek} anchor={bar} current={panel} />}
    </Sidebar>
  );
}

/** A panel's own component. */
function PanelView({ panel }: { panel: Panel }) {
  switch (panel.kind) {
    case "inbox":
      return <InboxPanel />;
    case "workflows":
      return <WorkflowsPanel />;
    case "workflow":
      return <WorkflowPanel name={panel.name} />;
    case "sites":
      return <SitesPanel />;
    case "data":
      return <DataPanel />;
    case "permissions":
      return <PermissionsPanel />;
  }
}

/** What the bar reads from the config: the app's name, and whether it has collections and a policy. */
const selectBar = (config: ConfigDescription) => ({
  appName: config.appName,
  hasData: config.collections.length > 0,
  hasPolicy: config.policy.defined,
});

/**
 * The brand, linking home; each section, the current one marked; who you are at the foot. While
 * no panel is docked (`peek` given), a section with a panel peeks it.
 */
function SectionBar({
  ref,
  peek,
}: {
  ref: RefObject<HTMLDivElement | null>;
  peek: PopoverPrimitive.Handle<PanelSection> | undefined;
}) {
  const {
    data: { appName, hasData, hasPolicy },
  } = useSuspenseQuery({ ...configQuery(), select: selectBar });
  // Sites, when there are sites: its link, the first page a site lists, and whether the page is
  // a site's, which lights it.
  const sites = useSites();
  const sitesHome = sites.find((site) => site.pages.length > 0)?.pages[0]?.to;
  const onSite = usePageSection() === "sites";
  // Sites, Data and Permissions, only when there is something to list.
  const shown: Partial<Record<string, boolean>> = { sites: sites.length > 0, data: hasData, permissions: hasPolicy };
  // The Inbox page's query (its costliest read), polled every 30 s for the badge. Each watcher
  // polls at its own interval, so while the Inbox page shows, its 5 s poll keeps the badge
  // fresh too; and a decision refreshes it at once.
  const { data: pending } = useQuery({
    ...waitingRunsQuery(),
    refetchInterval: 30_000,
    select: (runs) => pendingOf(runs).length,
  });
  return (
    <Sidebar ref={ref} collapsible="none" className="w-(--sidebar-width-icon) shrink-0 border-r">
      <SidebarHeader className="items-center py-3">
        <Link
          {...OVERVIEW}
          className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <ShieldCheckIcon aria-hidden="true" className="size-5" />
          <span className="sr-only">Sanoma, {appName}</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-1.5">
          <nav aria-label="Sections">
            <SidebarMenu className="gap-1">
              {SECTIONS.filter((section) => shown[section.panel ?? ""] ?? true).map((section) => (
                <SidebarMenuItem key={section.label}>
                  <SectionLink section={section} peek={section.panel && peek} sites={{ home: sitesHome, lit: onSite }}>
                    {/* After hydration only: the root loader starts this query without waiting for it,
                        so the server may render before it answers and the browser after. */}
                    {section.panel === "inbox" && (
                      <ClientOnly>
                        {!!pending && (
                          <Badge
                            className={cn(
                              toneBadge({ tone: "waiting" }),
                              "absolute top-1 right-1 h-4 min-w-4 px-1 text-[10px] tabular-nums",
                            )}
                          >
                            {pending}
                            <span className="sr-only"> waiting</span>
                          </Badge>
                        )}
                      </ClientOnly>
                    )}
                  </SectionLink>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="items-center">
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * A section's link: its icon, then `children` (its badge), then its label. With `peek`, it is also
 * the peek's trigger: the pointer resting on it, or the keyboard focusing it, opens its panel
 * beside the bar. Still a link: a click follows it (and closes the peek) rather than toggling the
 * peek, and the trigger's `role="button"` is left off. Sites, which has no `to`, links to
 * `sites.home` and is lit while `sites.lit`.
 */
function SectionLink({
  section: { label, icon: Icon, panel, to },
  peek,
  sites,
  children,
}: {
  section: Section;
  peek: PopoverPrimitive.Handle<PanelSection> | undefined;
  sites: { home: string | undefined; lit: boolean };
  children: ReactNode;
}) {
  const content = (
    <>
      <Icon aria-hidden="true" />
      {children}
      <span>{label}</span>
    </>
  );
  const link = (props: object) =>
    to === undefined ? (
      <Link {...props} to={sites.home} {...(sites.lit && ACTIVE)} className={BAR_ITEM} />
    ) : (
      <Link {...props} to={to} activeProps={ACTIVE} className={BAR_ITEM} />
    );
  if (!peek || !panel) return link({ children: content });
  return (
    <PopoverTrigger
      handle={peek}
      payload={panel}
      openOnHover
      delay={200}
      // The grace period: a diagonal move from the bar to the panel keeps it open.
      closeDelay={300}
      nativeButton={false}
      // Focus from the keyboard opens it too; a click's focus does not. (`:focus-visible`, which
      // a link takes from the keyboard only.)
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) peek.open(event.currentTarget.id);
      }}
      render={({ role: _button, ...props }) => link(props)}
    >
      {content}
    </PopoverTrigger>
  );
}

/**
 * The peek: the panel of the section the pointer rests on (the current panel when it is that
 * section's: a workflow's, inside one) over the page beside the bar, as tall as the window. A
 * click on its trigger follows the link rather than toggling it, and a link followed in it closes
 * it. Esc closes it and puts the keyboard's focus back on its section in the bar; Pin, in its
 * header, docks the page's panel, when it is the page's section's.
 */
function Peek({
  handle,
  anchor,
  current,
}: {
  handle: PopoverPrimitive.Handle<PanelSection>;
  anchor: RefObject<HTMLDivElement | null>;
  current: Panel | undefined;
}) {
  return (
    <PopoverPrimitive.Root
      handle={handle}
      onOpenChange={(open, details) => {
        if (details.reason === "trigger-press") details.cancel();
        // Focus may be in the peek, which closes: back to its section, while the peek is still
        // open. (Popup's `finalFocus` hands it back once the peek is gone, and that focus, from
        // the keyboard, would open it again.)
        else if (!open && details.reason === "escape-key")
          anchor.current?.querySelector<HTMLElement>("[data-popup-open]")?.focus();
      }}
    >
      {({ payload }) =>
        payload && (
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Positioner
              anchor={anchor}
              side="right"
              align="start"
              sideOffset={0}
              // As tall as the bar, from the window's top: no room kept at its edges.
              collisionPadding={0}
              className="isolate z-50"
            >
              <PopoverPrimitive.Popup
                aria-label={LABEL[payload]}
                // Focus stays on the section until Tab moves into the peek; Esc puts it back itself,
                // and a pointer leaving moves it nowhere.
                initialFocus={false}
                finalFocus={false}
                onClick={(event) => {
                  if (onLink(event)) handle.close();
                }}
                className="flex h-svh w-(--sidebar-panel-width) flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-left-2 data-closed:animate-out data-closed:fade-out-0"
              >
                <Suspense fallback={<PanelSkeleton />}>
                  <PanelView panel={current && sectionOf(current) === payload ? current : { kind: payload }} />
                </Suspense>
                {/* Pin docks the page's own panel: only that section's peek has it. */}
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                  {current && sectionOf(current) === payload
                    ? "Esc closes; Pin keeps it open"
                    : `Esc closes; click ${LABEL[payload]} to go there`}
                </p>
              </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
          </PopoverPrimitive.Portal>
        )
      }
    </PopoverPrimitive.Root>
  );
}
