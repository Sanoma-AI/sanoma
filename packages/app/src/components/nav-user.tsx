import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { ArrowsOutSimpleIcon } from "@phosphor-icons/react/dist/csr/ArrowsOutSimple";
import { ArrowsInSimpleIcon } from "@phosphor-icons/react/dist/csr/ArrowsInSimple";
import { DesktopIcon } from "@phosphor-icons/react/dist/csr/Desktop";
import { MoonIcon } from "@phosphor-icons/react/dist/csr/Moon";
import { SunIcon } from "@phosphor-icons/react/dist/csr/Sun";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { UserCircleGearIcon } from "@phosphor-icons/react/dist/csr/UserCircleGear";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { cn } from "#/lib/utils.ts";
import { Avatar, AvatarFallback } from "#/components/ui/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { useSidebar } from "#/components/ui/sidebar.tsx";
import { useActor } from "../actor.ts";
import { useDensity } from "./density.tsx";

/**
 * Who you are, the theme and the density, at the foot of the sidebar's section bar: your initials,
 * your name, your groups (and whom you act for, as an agent) and where the name comes from read
 * out to assistive tech and shown atop the menu, with Sign out when the login has one. The menu
 * renders only once opened, in the browser, so the stored theme never reaches the server's markup.
 * Switching to Compact folds the sidebar's panel once (not on a phone, where it is a sheet);
 * switching back leaves the sidebar as it is.
 */
export function NavUser() {
  const { isMobile, open, setOpen } = useSidebar();
  const { actor, groups, onBehalfOf, fromServer, error, signOut, setActor } = useActor();
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
  const name = actor ?? (fromServer ? "Not signed in" : "Who are you?");
  // Under the name, once there is one: the groups, and whom an agent acts for.
  const member = actor
    ? [
        groups.length ? groups.join(", ") : "no groups",
        ...(onBehalfOf === undefined ? [] : [`for ${onBehalfOf}`]),
      ].join(" · ")
    : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex size-10 items-center justify-center rounded-md outline-hidden transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent">
        <Avatar className="size-8 rounded-lg">
          <AvatarFallback className="rounded-lg">
            {actor ? actor.slice(0, 2).toUpperCase() : <UserIcon aria-hidden="true" className="size-6" />}
          </AvatarFallback>
        </Avatar>
        <span className="sr-only">
          {/* The name in this browser is read after hydration: until then, none. */}
          {(actor !== undefined || fromServer) && <span>{name}</span>}
          {member && <span>{`, ${member}`}</span>}
          {status && <span>{status}</span>}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-sm text-foreground">{name}</span>
            {member && <span className="font-normal text-foreground">{member}</span>}
            {status && <span className={cn("font-normal", error && "text-destructive")}>{status}</span>}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {!fromServer && (
          <>
            <DropdownMenuItem onClick={() => setActor(null)}>
              <UserCircleGearIcon aria-hidden="true" />
              Change name
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {signOut && (
          <>
            <DropdownMenuItem onClick={() => void signOutAt(signOut)}>
              <SignOutIcon aria-hidden="true" />
              Sign out
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
  );
}

/** Ends the session, then reloads the app, which shows the login's sign-in page. */
async function signOutAt(url: string) {
  const res = await fetch(url, { method: "POST" }).catch(() => undefined);
  if (res?.ok) window.location.assign("/");
  else toast.error("Could not sign out");
}

type Choice = { value: string; icon: PhosphorIcon; label: string };

const THEMES: Choice[] = [
  { value: "light", icon: SunIcon, label: "Light" },
  { value: "dark", icon: MoonIcon, label: "Dark" },
  { value: "system", icon: DesktopIcon, label: "System" },
];

const DENSITIES: Choice[] = [
  { value: "comfortable", icon: ArrowsOutSimpleIcon, label: "Comfortable" },
  { value: "compact", icon: ArrowsInSimpleIcon, label: "Compact" },
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
          <choice.icon aria-hidden="true" />
          {choice.label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}
