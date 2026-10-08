import { ChevronsUpDownIcon, MonitorIcon, MoonIcon, SunIcon, UserIcon, UserPenIcon } from "lucide-react";
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

/**
 * Who you are and the theme, in the sidebar's footer. The menu renders only once opened, in the
 * browser, so the stored theme never reaches the server's markup.
 */
export function NavUser() {
  const { isMobile } = useSidebar();
  const { actor, fromServer, error, setActor } = useActor();
  const { theme, setTheme } = useTheme();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
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
                  <span className="truncate font-medium">
                    {actor ?? (fromServer ? "Not signed in" : "Who are you?")}
                  </span>
                )}
                <span className={cn("truncate text-xs", error && "text-destructive")}>
                  {error ?? (fromServer ? "Signed in by the deployment" : "Name kept in this browser")}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuLabel>{error ?? (actor ? `You are ${actor}` : "Not signed in")}</DropdownMenuLabel>
            {!fromServer && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setActor(null)}>
                  <UserPenIcon />
                  Change name
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <SunIcon />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
