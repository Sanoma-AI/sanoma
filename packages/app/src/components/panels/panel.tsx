import { useLocation, useMatch } from "@tanstack/react-router";
import { PanelLeftCloseIcon, PinIcon } from "lucide-react";
import { createContext, type ReactNode, use } from "react";
import { SidebarHeader, useSidebar } from "#/components/ui/sidebar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { TipButton } from "../common.tsx";

// What the sidebar's panel lists, and the pieces every panel shares.

/** A section's panel: the Inbox's approvals, the workflows, or one workflow's runs (drilled in). */
export type Panel = { kind: "inbox" } | { kind: "workflows" } | { kind: "workflow"; name: string };

/** The sections that have a panel. Resources and Connectors have none, until they have something to list. */
export type PanelSection = "inbox" | "workflows";

/**
 * The panel the URL picks: the Inbox's under /inbox, the workflows' under /workflows, drilled into
 * one workflow on its page (either pane); none elsewhere.
 */
export function usePanel(): Panel | undefined {
  const name = useMatch({ from: "/workflows/$name", shouldThrow: false, select: (match) => match.params.name });
  const pathname = useLocation({ select: (location) => location.pathname });
  if (name !== undefined) return { kind: "workflow", name };
  if (pathname === "/workflows" || pathname.startsWith("/workflows/")) return { kind: "workflows" };
  if (pathname === "/inbox") return { kind: "inbox" };
  return undefined;
}

/** The section a panel belongs to: the bar item it peeks from. */
export const sectionOf = (panel: Panel): PanelSection => (panel.kind === "inbox" ? "inbox" : "workflows");

/**
 * Where a panel shows: `docked` beside the bar, `peek` over the page while the sidebar is folded,
 * or `sheet` on a phone. `close` closes the peek or the sheet, as a link in the panel is followed.
 */
type PanelPlace = { place: "docked" | "peek" | "sheet"; close: () => void };

const PanelContext = createContext<PanelPlace>({ place: "docked", close: () => {} });

export function PanelProvider({ value, children }: { value: PanelPlace; children: ReactNode }) {
  return <PanelContext value={value}>{children}</PanelContext>;
}

/** Where this panel shows, and how a link in it closes the peek or the sheet it is in. */
export const usePanelPlace = () => use(PanelContext);

/**
 * A panel's header: its title (an `<h2>`, or `title` as given), `actions` beside it, and the button
 * that folds the docked panel to the bar, or pins the peek open. Under them, `children`.
 */
export function PanelHeader({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { setOpen } = useSidebar();
  const { place, close } = usePanelPlace();
  return (
    <SidebarHeader className="gap-3 p-3">
      <div className="flex min-h-8 items-center gap-1">
        {typeof title === "string" ? <h2 className="flex-1 truncate px-1 text-base font-semibold">{title}</h2> : title}
        {actions}
        {place === "docked" && (
          <TipButton tip="Collapse the panel" size="icon-sm" onClick={() => setOpen(false)}>
            <PanelLeftCloseIcon />
          </TipButton>
        )}
        {place === "peek" && (
          <TipButton
            tip="Pin the panel"
            size="icon-sm"
            onClick={() => {
              setOpen(true);
              close();
            }}
          >
            <PinIcon />
          </TipButton>
        )}
      </div>
      {children}
    </SidebarHeader>
  );
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
