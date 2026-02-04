const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electron", {
  readSettings: () => ipcRenderer.invoke("read-settings"),
  writeSettings: (settings) => ipcRenderer.invoke("write-settings", settings)
});
console.log("Preload script executed!");
