import { ipcMain, BrowserWindow, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
const isDev = process.env.VITE_DEV_SERVER_URL !== void 0;
const preloadPath = isDev ? path.join(process.cwd(), "electron", "preload.js") : path.join(__dirname$1, "preload.js");
const settingsPath = path.join(__dirname$1, "settings.json");
let windows = [];
let mainWindow = null;
let analyticsWindow = null;
let sharedTimerData = {
  displayTimer: "00:00:00",
  activeButton: null,
  elapsedTime: 0,
  isRunning: false,
  selectedUser: null,
  pauseReason: [],
  currentSessionStart: null,
  sessions: []
  // Historical session data for analytics
};
ipcMain.handle("read-settings", async () => {
  try {
    const data = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Failed to read settings:", error);
    return { pauseReasons: [] };
  }
});
ipcMain.handle("write-settings", async (event, settings) => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return { success: true };
  } catch (error) {
    console.error("Failed to write settings:", error);
    return { success: false, error: error.message };
  }
});
ipcMain.handle("get-shared-data", () => {
  return sharedTimerData;
});
ipcMain.handle("get-window-type", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win === mainWindow) return "main";
  if (win === analyticsWindow) return "analytics";
  return "unknown";
});
ipcMain.on("update-shared-data", (event, newData) => {
  sharedTimerData = { ...sharedTimerData, ...newData };
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send("shared-data-changed", sharedTimerData);
    }
  });
});
ipcMain.on("add-session", (event, sessionData) => {
  sharedTimerData.sessions.push(sessionData);
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send("shared-data-changed", sharedTimerData);
    }
  });
});
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    resizable: false,
    maximizable: false,
    center: true
  });
  windows.push(mainWindow);
  mainWindow.on("closed", () => {
    windows = windows.filter((w) => w !== mainWindow);
    mainWindow = null;
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname$1, "../dist/index.html"));
  }
  return mainWindow;
}
function createAnalyticsWindow() {
  if (analyticsWindow && !analyticsWindow.isDestroyed()) {
    analyticsWindow.focus();
    return analyticsWindow;
  }
  analyticsWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "Analytics Dashboard"
  });
  windows.push(analyticsWindow);
  analyticsWindow.on("closed", () => {
    windows = windows.filter((w) => w !== analyticsWindow);
    analyticsWindow = null;
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    analyticsWindow.loadURL(process.env.VITE_DEV_SERVER_URL + "#/analytics");
    analyticsWindow.webContents.openDevTools();
  } else {
    analyticsWindow.loadFile(path.join(__dirname$1, "../dist/index.html"));
    analyticsWindow.webContents.on("did-finish-load", () => {
      analyticsWindow.webContents.send("navigate-to", "/analytics");
    });
  }
  return analyticsWindow;
}
ipcMain.on("open-analytics-window", () => {
  createAnalyticsWindow();
});
app.whenReady().then(createMainWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
