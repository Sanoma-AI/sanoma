import { useMatch, useMatches } from "@tanstack/react-router";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import type { ReactElement, ReactNode } from "react";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { siteOf } from "#/lib/sites.ts";
import type { Tone } from "#/lib/tone.ts";
import { type PanelSection, StatusDot, TipButton, When } from "../common.tsx";

// What the sidebar's panel lists, and the pieces every panel shares.

/** A section's panel: the Inbox's approvals, the workflows, one workflow's runs (drilled in), the sites, or the collections. */
export type Panel = { kind: PanelSection } | { kind: "workflow"; name: string };

/**
 * The section the page is under: its deepest route's `staticData.section`, if any route names one;
 * Sites for a site's page.
 */
const sectionOfMatches = (matches: { fullPath: string; staticData: { section?: PanelSection } }[]) =>
  matches.findLast((match) => match.staticData.section)?.staticData.section ??
  (siteOf(matches.at(-1)?.fullPath) === undefined ? undefined : "sites");

/** The page's section, if it has a panel. */
export const usePageSection = () => useMatches({ select: sectionOfMatches });

/** Whether the page's section has a panel. */
export const useHasPanel = () => usePageSection() !== undefined;

/**
 * The panel the page's section has (its route's `staticData.section`), drilled into a workflow on
 * its page (either pane); none for a section without one.
 */
export function usePanel(): Panel | undefined {
  const section = usePageSection();
  const name = useMatch({ from: "/workflows/$name", shouldThrow: false, select: (match) => match.params.name });
  if (section === "workflows" && name !== undefined) return { kind: "workflow", name };
  return section && { kind: section };
}

/** The section a panel belongs to: the bar item it peeks from. */
export const sectionOf = (panel: Panel): PanelSection => (panel.kind === "workflow" ? "workflows" : panel.kind);

/** A link lit while it is the page open (Link sets `aria-current` too): for `activeProps`. */
export const ACTIVE = { "data-active": true } as const;

/**
 * A panel's header: its title (an `<h2>`, or `title` as given), `actions` beside it, and the button
 * that folds the docked panel to the bar, or pins the peek open when it is the panel of the page's
 * own section (`section`), the one pinning docks. Under them, `children`. The panel is docked
 * while the sidebar is open on a page with a panel, in a sheet on a phone, and peeking otherwise.
 */
export function PanelHeader({
  section,
  title,
  actions,
  children,
}: {
  section: PanelSection;
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { isMobile, open, setOpen } = useSidebar();
  const pageSection = usePageSection();
  const place = isMobile ? "sheet" : open && pageSection !== undefined ? "docked" : "peek";
  return (
    <SidebarHeader className="gap-3 p-3">
      <div className="flex min-h-8 items-center gap-1">
        {typeof title === "string" ? <h2 className="flex-1 truncate px-1 text-base font-semibold">{title}</h2> : title}
        {actions}
        {place === "docked" && (
          <TipButton tip="Collapse the panel" size="icon-sm" onClick={() => setOpen(false)}>
            <SidebarSimpleIcon aria-hidden="true" />
          </TipButton>
        )}
        {/* Opening the sidebar docks the page's panel, which closes the peek. */}
        {place === "peek" && section === pageSection && (
          <TipButton tip="Pin the panel" size="icon-sm" onClick={() => setOpen(true)}>
            <PushPinIcon aria-hidden="true" />
          </TipButton>
        )}
      </div>
      {children}
    </SidebarHeader>
  );
}

/**
 * A row of a panel's list, a link (`link`): a dot in its `tone`, its `title`, when it happened at
 * the end, and under them its `lines`, each cut to one line so the rows keep the panel's width.
 * `isActive` marks it when the link itself cannot tell (Link's `activeProps` can).
 */
export function PanelRow({
  link,
  tone,
  title,
  at,
  lines,
  isActive,
}: {
  link: ReactElement;
  tone: Tone;
  title: ReactNode;
  at: number;
  lines: ReactNode[];
  isActive?: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={isActive} className="h-auto flex-col items-stretch gap-0.5 py-1.5" render={link}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} />
          {title}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            <When at={at} />
          </span>
        </span>
        {lines.map(
          (line, i) =>
            line && (
              <span key={i} className="truncate pl-4.5 text-xs text-muted-foreground">
                {line}
              </span>
            ),
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** A panel's foot: one link, `link`, to the whole of what it lists. */
export function PanelFooterLink({ link, children }: { link: ReactElement; children: ReactNode }) {
  return (
    <SidebarFooter className="border-t">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton render={link} className="text-muted-foreground">
            <span>{children}</span>
            <ArrowRightIcon aria-hidden="true" className="ml-auto" />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

/** What a panel's list says when it lists nothing. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2 text-sm text-muted-foreground">{children}</p>;
}

/**
 * A panel's place while its reads load: a few rows' skeletons. (Not SidebarMenuSkeleton, whose
 * random width would differ between the server and the browser.)
 */
export function PanelSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2 p-3">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}
