import { ScriptOnce } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

// shadcn's dark mode for TanStack Start (ui.shadcn.com/docs/dark-mode/tanstack-start), with the
// script split out so the document renders it in <head>: it sets the class before the body paints.

export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "sanoma.theme";
const DEFAULT_THEME: Theme = "system";

const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark" || value === "system";

function themeScript(storageKey: string, defaultTheme: Theme) {
  const key = JSON.stringify(storageKey);
  const fallback = JSON.stringify(defaultTheme);
  return `(function(){try{var t=localStorage.getItem(${key});if(t!=='light'&&t!=='dark'&&t!=='system'){t=${fallback}}var d=matchMedia('(prefers-color-scheme: dark)').matches;var r=t==='system'?(d?'dark':'light'):t;var e=document.documentElement;e.classList.add(r);e.style.colorScheme=r}catch(e){}})();`;
}

/** For the document's <head>: applies the stored theme, or the system's, before the first paint. */
export function ThemeScript() {
  return <ScriptOnce>{themeScript(STORAGE_KEY, DEFAULT_THEME)}</ScriptOnce>;
}

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState>({ theme: DEFAULT_THEME, setTheme: () => {} });

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  const resolved =
    theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setThemeState(readTheme());
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) applyTheme(theme);
  }, [theme, mounted]);

  useEffect(() => {
    if (!mounted || theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme, mounted]);

  const setTheme = (next: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: the choice lasts until the page reloads.
    }
    setThemeState(next);
  };

  return <ThemeProviderContext value={{ theme, setTheme }}>{children}</ThemeProviderContext>;
}

export const useTheme = () => useContext(ThemeProviderContext);
