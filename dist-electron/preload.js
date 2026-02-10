const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electron", {
  // Existing settings methods
  readSettings: () => ipcRenderer.invoke("read-settings"),
  writeSettings: (settings) => ipcRenderer.invoke("write-settings", settings),
  // Shared data methods
  getSharedData: () => ipcRenderer.invoke("get-shared-data"),
  getWindowType: () => ipcRenderer.invoke("get-window-type"),
  updateSharedData: (data) => ipcRenderer.send("update-shared-data", data),
  addSession: (sessionData) => ipcRenderer.send("add-session", sessionData),
  onSharedDataChanged: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on("shared-data-changed", subscription);
    return () => {
      ipcRenderer.removeListener("shared-data-changed", subscription);
    };
  },
  // Window management
  openAnalyticsWindow: () => ipcRenderer.send("open-analytics-window"),
  // Navigation (for analytics window)
  onNavigateTo: (callback) => {
    ipcRenderer.on("navigate-to", (event, route) => callback(route));
  }
});
console.log("Preload script executed!");
