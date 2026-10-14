import {
  ChevronsUpDownIcon,
  type LucideIcon,
  Maximize2Icon,
  Minimize2Icon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UserIcon,
  UserPenIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "#/lib/utils.ts";
import { Avatar, AvatarFallback } from "#/components/ui/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "#/components/ui/sidebar.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { useActor } from "../actor.ts";
import { useDensity } from "./density.tsx";

/**
 * Who you are, the theme and the density, in the sidebar's footer. The menu renders only once
 * opened, in the browser, so the stored theme never reaches the server's markup. Switching to
 * Compact folds the sidebar to its icons once (not on a phone, where it is a sheet); switching
 * back leaves the sidebar as it is.
 */
export function NavUser() {
  const { isMobile, open, setOpen } = useSidebar();
  const { actor, fromServer, error, setActor } = useActor();
  const { theme, setTheme } = useTheme();
  const { compact, setCompact } = useDensity();
  const setDensity = (value: string) => {
    const next = value === "compact";
    if (next && !compact && !isMobile && open) setOpen(false);
    setCompact(next);
  };
  // Under the name: why the deployment could not say, or where the name comes from; nothing
  // when there is no name.
  const status =
    error ?? (actor ? (fromServer ? "Signed in by the deployment" : "Name kept in this browser") : undefined);
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
              />
            }
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg">
                {actor ? actor.slice(0, 2).toUpperCase() : <UserIcon />}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              {/* The name in this browser is read after hydration: until then, a placeholder. */}
              {actor === undefined && !fromServer ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span className="truncate font-medium">{actor ?? (fromServer ? "Not signed in" : "Who are you?")}</span>
              )}
              {status && <span className={cn("truncate text-xs", error && "text-destructive")}>{status}</span>}
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            {!fromServer && (
              <>
                <DropdownMenuItem onClick={() => setActor(null)}>
                  <UserPenIcon />
                  Change name
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <Choices label="Theme" value={theme ?? "system"} onValueChange={setTheme} choices={THEMES} />
            <DropdownMenuSeparator />
            <Choices
              label="Density"
              value={compact ? "compact" : "comfortable"}
              onValueChange={setDensity}
              choices={DENSITIES}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

type Choice = { value: string; icon: LucideIcon; label: string };

const THEMES: Choice[] = [
  { value: "light", icon: SunIcon, label: "Light" },
  { value: "dark", icon: MoonIcon, label: "Dark" },
  { value: "system", icon: MonitorIcon, label: "System" },
];

const DENSITIES: Choice[] = [
  { value: "comfortable", icon: Maximize2Icon, label: "Comfortable" },
  { value: "compact", icon: Minimize2Icon, label: "Compact" },
];

/**
 * One labelled radio group of the menu. The label sits inside its group, which Base UI requires
 * and which names the group; a choice closes the menu (`closeOnClick`; Base UI keeps it open).
 */
function Choices({
  label,
  value,
  onValueChange,
  choices,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  choices: Choice[];
}) {
  return (
    <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      {choices.map((choice) => (
        <DropdownMenuRadioItem key={choice.value} closeOnClick value={choice.value}>
          <choice.icon />
          {choice.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
