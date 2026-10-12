import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

// The page's density: comfortable, or Compact for people who live in the app. Kept in a cookie
// so the server renders the chosen density (the root's loader reads it), as the sidebar's is.

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
 * Holds the density, starting from `defaultCompact`: the server's reading of the cookie, which
 * hydration gets from the root's loader data. The browser never reads the cookie for its first
 * render, so both render the same page; the setter writes it, as SidebarProvider's does.
 */
export function DensityProvider({
  defaultCompact = false,
  children,
}: {
  /** Undefined in a loader's run in the browser, which comes after the provider has mounted. */
  defaultCompact?: boolean;
  children: ReactNode;
}) {
  const [compact, setState] = useState(defaultCompact);
  const setCompact = useCallback((value: boolean) => {
    setState(value);
    document.cookie = `${DENSITY_COOKIE}=${value ? "compact" : "comfortable"}; path=/; max-age=${DENSITY_COOKIE_MAX_AGE}`;
  }, []);
  const density = useMemo(() => ({ compact, setCompact }), [compact, setCompact]);
  return <DensityContext value={density}>{children}</DensityContext>;
}
