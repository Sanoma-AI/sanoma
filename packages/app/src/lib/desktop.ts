import { useEffect, useState } from "react";

/** A company open in the desktop shell's window, as its preload names it: an opaque id, never a path. */
export interface DesktopCompany {
  id: string;
  name: string;
  /** Whether the window shows it: this app's own company. */
  shown: boolean;
}

/**
 * What the desktop shell gives the app it shows (`window.sanomaDesktop`, its app view's preload,
 * `packages/desktop/src/app-preload.ts`): the window's companies, for the account menu. There is
 * nothing else, and outside the shell there is no such object.
 */
export interface SanomaDesktop {
  companies(): Promise<DesktopCompany[]>;
  /** Shows the company with that id in the window, in place of this one. */
  switch(id: string): Promise<void>;
  /** Shows the shell's start screen in the window: open, start or clone another company. */
  addCompany(): Promise<void>;
  /** Calls `listener` with the companies whenever they or the one shown change; returns how to stop. */
  onCompanies(listener: (companies: DesktopCompany[]) => void): () => void;
}

/** The desktop shell's API, when the app runs in its window; never on the server. */
export const desktopShell = (): SanomaDesktop | undefined =>
  typeof window === "undefined" ? undefined : (window as { sanomaDesktop?: SanomaDesktop }).sanomaDesktop;

/**
 * The companies open in the desktop shell's window, kept current; undefined outside the shell
 * (and on the server, and until the shell has answered).
 */
export function useDesktopCompanies(): DesktopCompany[] | undefined {
  const [companies, setCompanies] = useState<DesktopCompany[]>();
  useEffect(() => {
    const desktop = desktopShell();
    if (!desktop) return;
    let live = true;
    const off = desktop.onCompanies(setCompanies);
    void desktop.companies().then((listed) => live && setCompanies(listed));
    return () => {
      live = false;
      off();
    };
  }, []);
  return companies;
}
