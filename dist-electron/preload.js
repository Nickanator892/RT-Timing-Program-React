const { contextBridge: i, ipcRenderer: e } = require("electron");
i.exposeInMainWorld("electron", {
  // Settings
  readSettings: () => e.invoke("read-settings"),
  writeSettings: (t) => e.invoke("write-settings", t),
  // Shared data
  getSharedData: () => e.invoke("get-shared-data"),
  getWindowType: () => e.invoke("get-window-type"),
  updateSharedData: (t) => e.send("update-shared-data", t),
  addSession: (t) => e.send("add-session", t),
  onSharedDataChanged: (t) => {
    const n = (s, a) => t(a);
    return e.on("shared-data-changed", n), () => {
      e.removeListener("shared-data-changed", n), e.setMaxListeners(50);
    };
  },
  // Timer controls
  timerStart: () => e.send("timer-start"),
  timerPause: () => e.send("timer-pause"),
  timerReset: () => e.send("timer-reset"),
  // Window management
  openAnalyticsWindow: () => e.send("open-analytics-window"),
  quitApp: () => e.send("quit-app"),
  // Navigation
  onNavigateTo: (t) => {
    const n = (s, a) => t(a);
    return e.on("navigate-to", n), () => {
      e.removeListener("navigate-to", n);
    };
  }
});
console.log("Preload script executed!");
