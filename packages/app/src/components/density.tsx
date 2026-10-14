import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

// The page's density: comfortable, or Compact for people who live in the app (see DensityProvider).

/** The cookie the density is kept in: `compact` or `comfortable` (and, never set, comfortable). */
export const DENSITY_COOKIE = "sanoma_density";

/** A year, in seconds. */
const DENSITY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

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
 * Compact (unmarked otherwise): the `compact:` variant and style.css's spacing tokens key on it,
 * as SidebarProvider renders its own wrapper. The density lives in a cookie, as the sidebar's
 * state does, so the server renders the chosen one from the first paint: the root's loader reads
 * it into `defaultCompact`, which the provider takes once, as it mounts (hydration has the
 * server's answer, so both render the same page); the setter writes it. On #app rather than
 * <html>, since the density is the root's state; Radix portals (menus, dialogs) land in <body>,
 * outside it, and keep the comfortable spacing.
 */
export function DensityProvider({ defaultCompact, children }: { defaultCompact: boolean; children: ReactNode }) {
  const [compact, setState] = useState(defaultCompact);
  const setCompact = useCallback((value: boolean) => {
    setState(value);
    document.cookie = `${DENSITY_COOKIE}=${value ? "compact" : "comfortable"}; path=/; max-age=${DENSITY_COOKIE_MAX_AGE}`;
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
