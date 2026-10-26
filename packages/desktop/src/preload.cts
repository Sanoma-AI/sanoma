// The start window's bridge (CommonJS: a sandboxed preload cannot be a module). The company's
// windows have no preload: the app does not know it runs in the shell.
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("sanoma", {
  state: () => ipcRenderer.invoke("start:state"),
  choose: () => ipcRenderer.invoke("start:choose"),
  open: (path: string) => ipcRenderer.invoke("start:open", path),
  again: () => ipcRenderer.invoke("start:again"),
  onState: (listener: (state: unknown) => void) => ipcRenderer.on("start:state", (_event, state) => listener(state)),
});
