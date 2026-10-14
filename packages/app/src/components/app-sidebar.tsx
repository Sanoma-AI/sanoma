import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, Link, linkOptions } from "@tanstack/react-router";
import { BoxesIcon, InboxIcon, PlugIcon, ShieldCheckIcon, WorkflowIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, type RefObject, Suspense, useRef, useState } from "react";
import { NavUser } from "#/components/nav-user.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Popover, PopoverTrigger } from "#/components/ui/popover.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { configQuery, pendingByWorkflow, waitingRunsQuery } from "../queries.ts";
import { InboxPanel } from "./panels/inbox-panel.tsx";
import { type Panel, PanelProvider, type PanelSection, PanelSkeleton, sectionOf, usePanel } from "./panels/panel.tsx";
import { WorkflowPanel } from "./panels/workflow-panel.tsx";
import { WorkflowsPanel } from "./panels/workflows-panel.tsx";

// The sidebar: a bar of the app's sections, and beside it the panel that lists the current one
// (shadcn's sidebar-09, two sidebars in one). Folded, the bar stays and its sections peek their panel.

/** The bar's sections, and the panel each lists. (Each page's own name is its route's crumb.) */
const SECTIONS = linkOptions([
  { to: "/inbox", label: "Inbox", icon: InboxIcon, panel: "inbox" },
  { to: "/workflows", label: "Workflows", icon: WorkflowIcon, panel: "workflows" },
  { to: "/resources", label: "Resources", icon: BoxesIcon, panel: undefined },
  { to: "/connectors", label: "Connectors", icon: PlugIcon, panel: undefined },
]);

type Section = (typeof SECTIONS)[number];

/** The bar's width, with room for a label under each icon, and the panel's beside it (`w-68`, docked or peeking). */
const BAR_WIDTH = "4.5rem";
const PANEL_WIDTH = "17rem";

/**
 * The sidebar's widths, for SidebarProvider's `style`: the bar folded (`--sidebar-width-icon`), and
 * open the bar and the panel, or the bar alone in a section with no panel, so its page gets the room.
 */
export function useSidebarWidths(): CSSProperties {
  const panel = usePanel();
  return {
    "--sidebar-width-icon": BAR_WIDTH,
    "--sidebar-width": panel ? `calc(${BAR_WIDTH} + ${PANEL_WIDTH})` : BAR_WIDTH,
  } as CSSProperties;
}

/** A section's link, lit while its page or one under it shows (Link sets `aria-current` too). */
const ACTIVE = { "data-active": true } as const;

/**
 * A section in the bar: its icon, its label under it. The same open or folded (SidebarMenuButton
 * shrinks to an icon while the sidebar is folded: not here).
 */
const BAR_ITEM =
  "relative h-auto flex-col gap-1 p-[0.5rem_0.125rem] text-[11px] leading-none group-data-[collapsible=icon]:size-auto! group-data-[collapsible=icon]:p-[0.5rem_0.125rem]! [&_svg]:size-5";

/**
 * The sidebar: the section bar, and beside it the current section's panel (`usePanel`), open or
 * folded away (SidebarProvider's state, kept in its cookie). Folded, each section with a panel
 * peeks it over the page, as the pointer rests on it or the keyboard focuses it. On a phone the
 * sidebar is a sheet holding both, its links closing it.
 */
export function AppSidebar() {
  const { open, isMobile, setOpenMobile } = useSidebar();
  const panel = usePanel();
  // The phone's sheet is its only way around: in a section with no panel, it lists the workflows.
  const docked = panel ?? (isMobile ? ({ kind: "workflows" } as const) : undefined);
  const bar = useRef<HTMLDivElement>(null);
  // One peek for every section, so moving between sections swaps what it shows.
  const [peek] = useState(() => PopoverPrimitive.createHandle<PanelSection>());
  const peeking = !open && !isMobile;
  return (
    <Sidebar collapsible="icon" className="overflow-hidden">
      {/* Bar and panel side by side, in the sheet on a phone too. */}
      <div className="flex min-h-0 flex-1">
        <SectionBar ref={bar} peek={peeking ? peek : undefined} />
        {docked && (open || isMobile) && (
          <Sidebar collapsible="none" className="w-auto min-w-0 flex-1 md:w-68 md:flex-none">
            <PanelProvider value={{ place: isMobile ? "sheet" : "docked", close: () => setOpenMobile(false) }}>
              <Suspense fallback={<PanelSkeleton />}>
                <PanelView panel={docked} />
              </Suspense>
            </PanelProvider>
          </Sidebar>
        )}
      </div>
      <SidebarRail />
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
  }
}

/**
 * The brand, linking home; each section, the current one marked; who you are at the foot. While
 * the sidebar is folded (`peek` given), a section with a panel peeks it.
 */
function SectionBar({
  ref,
  peek,
}: {
  ref: RefObject<HTMLDivElement | null>;
  peek: PopoverPrimitive.Handle<PanelSection> | undefined;
}) {
  const { data: appName } = useSuspenseQuery({ ...configQuery(), select: (config) => config.appName });
  const { setOpenMobile } = useSidebar();
  // On a phone the sidebar is a sheet over the page: every link in it closes it on the way.
  const close = () => setOpenMobile(false);
  // The Inbox page's query (its costliest read), polled every 30 s for the badge. Each watcher
  // polls at its own interval, so while the Inbox page shows, its 5 s poll keeps the badge
  // fresh too; and a decision refreshes it at once.
  const { data: pending } = useQuery({ ...waitingRunsQuery(), refetchInterval: 30_000, select: pendingByWorkflow });
  return (
    <Sidebar ref={ref} collapsible="none" className="w-(--sidebar-width-icon) shrink-0 border-r">
      <SidebarHeader className="items-center py-3">
        <Link
          to="/workflows"
          activeOptions={{ exact: true, includeSearch: false }}
          onClick={close}
          className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <ShieldCheckIcon className="size-5" />
          <span className="sr-only">Sanoma, {appName}</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-1.5">
          <nav aria-label="Sections">
            <SidebarMenu className="gap-1">
              {SECTIONS.map((section) => (
                <SidebarMenuItem key={section.to}>
                  <SectionLink section={section} peek={section.panel && peek} onClick={close}>
                    {/* After hydration only: the root loader starts this query without waiting for it,
                        so the server may render before it answers and the browser after. */}
                    {section.panel === "inbox" && (
                      <ClientOnly>
                        {pending && pending.total > 0 && (
                          <Badge className="absolute top-1 right-1 h-4 min-w-4 bg-tone-waiting px-1 text-[10px] text-tone-waiting-foreground tabular-nums">
                            {pending.total}
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
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * A section's link: its icon, then `children` (its badge), then its label. With `peek`, it is also
 * the peek's trigger: the pointer resting on it, or the keyboard focusing it, opens its panel
 * beside the bar. Still a link: a click follows it (and closes the peek) rather than toggling the
 * peek, and the trigger's `role="button"` is left off.
 */
function SectionLink({
  section: { label, icon: Icon, panel, ...link },
  peek,
  onClick,
  children,
}: {
  section: Section;
  peek: PopoverPrimitive.Handle<PanelSection> | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  const content = (
    <>
      <Icon />
      {children}
      <span>{label}</span>
    </>
  );
  if (!peek || !panel) {
    return (
      <SidebarMenuButton className={BAR_ITEM} render={<Link {...link} activeProps={ACTIVE} onClick={onClick} />}>
        {content}
      </SidebarMenuButton>
    );
  }
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
      render={({ role: _button, ...props }) => (
        <SidebarMenuButton
          {...(props as object)}
          className={BAR_ITEM}
          render={
            <Link
              {...link}
              activeProps={ACTIVE}
              onClick={() => {
                onClick();
                peek.close();
              }}
            />
          }
        />
      )}
    >
      {content}
    </PopoverTrigger>
  );
}

const isSection = (payload: unknown): payload is PanelSection => payload === "inbox" || payload === "workflows";

/**
 * The peek: the panel of the section the pointer rests on (the current panel when it is that
 * section's: a workflow's, inside one) over the page beside the bar, as tall as the window. A
 * click on its trigger follows the link rather than toggling it. Esc closes it and puts focus back
 * on its section in the bar; Pin, in its header, opens the sidebar's panel.
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
    <Popover
      handle={handle}
      onOpenChange={(open, details) => {
        if (details.reason === "trigger-press") details.cancel();
        // Focus may be in the peek, which closes: back to its section.
        else if (!open && details.reason === "escape-key")
          anchor.current?.querySelector<HTMLElement>("[data-popup-open]")?.focus();
      }}
    >
      {/* The handle's payload: shadcn's Popover drops its type. */}
      {({ payload }) =>
        isSection(payload) && (
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
                aria-label={payload === "inbox" ? "Inbox" : "Workflows"}
                // Focus stays on the section until Tab moves into the peek; Esc puts it back itself.
                initialFocus={false}
                finalFocus={false}
                className="flex h-svh w-68 flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-left-2 data-closed:animate-out data-closed:fade-out-0"
              >
                <PanelProvider value={{ place: "peek", close: () => handle.close() }}>
                  <Suspense fallback={<PanelSkeleton />}>
                    <PanelView panel={current && sectionOf(current) === payload ? current : { kind: payload }} />
                  </Suspense>
                </PanelProvider>
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">Esc closes; Pin keeps it open</p>
              </PopoverPrimitive.Popup>
            </PopoverPrimitive.Positioner>
          </PopoverPrimitive.Portal>
        )
      }
    </Popover>
  );
}
