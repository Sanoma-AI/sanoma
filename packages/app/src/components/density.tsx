import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { rememberPref } from "./shell/prefs.ts";

// The page's density: comfortable, or Compact for people who live in the app (see DensityProvider).

/** The cookie the density is kept in: `compact` or `comfortable` (and, never set, comfortable). */
export const DENSITY_COOKIE = "sanoma_density";

type Density = { compact: boolean; setCompact: (compact: boolean) => void };

const DensityContext = createContext<Density | null>(null);

/** The density, and the setter that changes it and remembers it in the cookie. */
export function useDensity(): Density {
  const density = useContext(DensityContext);
  if (!density) throw new Error("useDensity must be used within a DensityProvider.");
  return density;
}

/**
 * Holds the density and renders the app's box, `#app`, marked `data-density="compact"` while
 * Compact (unmarked otherwise): the `compact:` variant and style.css's spacing unit and tokens key on it,
 * as the chrome renders no wrapper of its own. The density lives in a cookie, as the chat
 * column's state does, so the server renders the chosen one from the first paint: the root's loader reads
 * it into `defaultCompact`, which the provider takes once, as it mounts (hydration has the
 * server's answer, so both render the same page); the setter writes it. On #app rather than
 * <html>, since the density is the root's state; Base UI's portals (menus, dialogs) land in <body>,
 * outside it, and keep the comfortable spacing.
 */
export function DensityProvider({ defaultCompact, children }: { defaultCompact: boolean; children: ReactNode }) {
  const [compact, setState] = useState(defaultCompact);
  const setCompact = useCallback((value: boolean) => {
    setState(value);
    rememberPref(DENSITY_COOKIE, value ? "compact" : "comfortable");
  }, []);
  const density = useMemo(() => ({ compact, setCompact }), [compact, setCompact]);
  return (
    <DensityContext value={density}>
      <div id="app" data-density={compact ? "compact" : undefined}>
        {children}
      </div>
    </DensityContext>
  );
}
