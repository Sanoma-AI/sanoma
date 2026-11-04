// The bridge of the shell's own pages, the start screen and each company's progress page (Vite
// builds it as CommonJS, preload.cjs: a sandboxed preload cannot be a module). A company's app view
// has its own, smaller one (app-preload.ts).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sanoma", {
  state: () => ipcRenderer.invoke("start:state"),
  choose: () => ipcRenderer.invoke("start:choose"),
  open: (path: string) => ipcRenderer.invoke("start:open", path),
  again: () => ipcRenderer.invoke("start:again"),
  skip: () => ipcRenderer.invoke("start:skip"),
  create: () => ipcRenderer.invoke("start:create"),
  clone: () => ipcRenderer.invoke("start:clone"),
  answer: (kind: string, value: unknown) => ipcRenderer.invoke("start:answer", kind, value),
  cancel: () => ipcRenderer.invoke("start:cancel"),
  changePlace: () => ipcRenderer.invoke("start:change-place"),
  download: () => ipcRenderer.invoke("start:download"),
  stop: () => ipcRenderer.invoke("start:stop"),
  gotIt: () => ipcRenderer.invoke("start:got-it"),
  setDetails: (details: boolean) => ipcRenderer.invoke("start:details", details),
  copyDetails: () => ipcRenderer.invoke("start:copy-details"),
  showLog: () => ipcRenderer.invoke("start:show-log"),
  onState: (listener: (state: unknown) => void) => ipcRenderer.on("start:state", (_event, state) => listener(state)),
});
