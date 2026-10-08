import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

const NEXT = { light: "dark", dark: "system", system: "light" } as const;
const ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon };
type Mode = keyof typeof NEXT;

const noop = () => () => {};

/** Light, dark, or the system's: one button that shows the choice and moves to the next. */
export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  // The server renders no stored choice: show "system" until hydrated, so the markup matches.
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const mode: Mode = hydrated && (theme === "light" || theme === "dark") ? theme : "system";
  const Icon = ICON[mode];
  const label = `Theme: ${mode}`;
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={() => setTheme(NEXT[mode])}>
      <Icon />
    </Button>
  );
}
