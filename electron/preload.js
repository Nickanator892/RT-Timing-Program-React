const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
    // Settings
    readSettings: () => ipcRenderer.invoke("read-settings"),
    writeSettings: (settings) => ipcRenderer.invoke("write-settings", settings),

    // Shared data
    getSharedData: () => ipcRenderer.invoke("get-shared-data"),
    getWindowType: () => ipcRenderer.invoke("get-window-type"),
    updateSharedData: (data) => ipcRenderer.send("update-shared-data", data),
    addSession: (sessionData) => ipcRenderer.send("add-session", sessionData),
    onSharedDataChanged: (callback) => {
        const subscription = (event, data) => callback(data);
        ipcRenderer.on("shared-data-changed", subscription);
        return () => {
            ipcRenderer.removeListener("shared-data-changed", subscription);
            ipcRenderer.setMaxListeners(50);
        };
    },

    // Timer controls
    timerStart: () => ipcRenderer.send("timer-start"),
    timerPause: () => ipcRenderer.send("timer-pause"),
    timerReset: () => ipcRenderer.send("timer-reset"),

    // Window management
    openAnalyticsWindow: () => ipcRenderer.send("open-analytics-window"),

    // Navigation
    onNavigateTo: (callback) => {
        const subscription = (event, route) => callback(route);
        ipcRenderer.on("navigate-to", subscription);
        return () => {
            ipcRenderer.removeListener("navigate-to", subscription);
        };
    },
});

console.log("Preload script executed!");
