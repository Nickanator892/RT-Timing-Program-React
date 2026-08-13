const { contextBridge: s, ipcRenderer: e } = require("electron");
s.exposeInMainWorld("electron", {
  // Settings
  readSettings: () => e.invoke("read-settings"),
  writeSettings: (t) => e.invoke("write-settings", t),
  // Shared data
  getSharedData: () => e.invoke("get-shared-data"),
  getWindowType: () => e.invoke("get-window-type"),
  updateSharedData: (t) => e.send("update-shared-data", t),
  addSession: (t) => e.send("add-session", t),
  onSharedDataChanged: (t) => {
    const n = (r, a) => t(a);
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
    const n = (r, a) => t(a);
    return e.on("navigate-to", n), () => {
      e.removeListener("navigate-to", n);
    };
  },
  runUpdater: () => e.invoke("run-updater")
});
console.log("Preload script executed!");
