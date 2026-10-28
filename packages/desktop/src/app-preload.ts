// The app view's preload (app-preload.cjs): the one thing the shell gives a company's app, the
// window's companies for the account menu's Companies section (the app's `nav-user.tsx`), which
// lists them, switches to one, and adds one. Nothing else: the page runs the company's own code.
// The shell answers only the app's own top page (`isAppPage`); ids are opaque, never paths.
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { DesktopCompany } from "./main.ts";

contextBridge.exposeInMainWorld("sanomaDesktop", {
  companies: (): Promise<DesktopCompany[]> => ipcRenderer.invoke("desktop:companies"),
  switch: (id: string) => ipcRenderer.invoke("desktop:switch", id),
  addCompany: () => ipcRenderer.invoke("desktop:add"),
  /** Calls `listener` with the companies whenever they or the one shown change; returns how to stop. */
  onCompanies: (listener: (companies: DesktopCompany[]) => void) => {
    const handler = (_event: IpcRendererEvent, companies: DesktopCompany[]) => listener(companies);
    ipcRenderer.on("desktop:companies", handler);
    return () => void ipcRenderer.removeListener("desktop:companies", handler);
  },
});
