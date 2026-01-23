import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
