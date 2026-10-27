// The bridge of the shell's own pages, the start window and a company window's progress page
// (Vite builds it as CommonJS, preload.cjs: a sandboxed preload cannot be a module). The app's view
// in a company window has no preload: the app does not know it runs in the shell.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sanoma", {
  state: () => ipcRenderer.invoke("start:state"),
  choose: () => ipcRenderer.invoke("start:choose"),
  open: (path: string) => ipcRenderer.invoke("start:open", path),
  again: () => ipcRenderer.invoke("start:again"),
  skip: () => ipcRenderer.invoke("start:skip"),
  create: () => ipcRenderer.invoke("start:create"),
  clone: () => ipcRenderer.invoke("start:clone"),
  answer: (value: unknown) => ipcRenderer.invoke("start:answer", value),
  cancel: () => ipcRenderer.invoke("start:cancel"),
  onState: (listener: (state: unknown) => void) => ipcRenderer.on("start:state", (_event, state) => listener(state)),
});
