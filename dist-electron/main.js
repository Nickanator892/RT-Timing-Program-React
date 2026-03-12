import { ipcMain, BrowserWindow, screen, app } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import "child_process";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
const isDev = process.env.VITE_DEV_SERVER_URL !== void 0;
const preloadPath = isDev ? path.join(process.cwd(), "electron", "preload.js") : path.join(__dirname$1, "preload.js");
const settingsPath = path.join(__dirname$1, "settings.json");
let windows = [];
let mainWindow = null;
let analyticsWindow = null;
let timerInterval = null;
let timerStart = null;
let timerElapsed = 0;
let sharedTimerData = {
  displayTimer: "00:00:00",
  activeButton: null,
  elapsedTime: 0,
  isRunning: false,
  selectedUser: null,
  pauseReason: [],
  currentSessionStart: null,
  sessions: []
};
function broadcastToAll(data) {
  windows.forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send("shared-data-changed", data);
    }
  });
}
let broadcastDebounceTimer = null;
function broadcastNonTimer(data) {
  if (broadcastDebounceTimer) clearTimeout(broadcastDebounceTimer);
  broadcastDebounceTimer = setTimeout(() => {
    broadcastToAll(data);
  }, 100);
}
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;
}
ipcMain.on("timer-start", () => {
  if (timerInterval) return;
  timerStart = Date.now() - timerElapsed;
  sharedTimerData.isRunning = true;
  broadcastToAll(sharedTimerData);
  function tick() {
    timerElapsed = Date.now() - timerStart;
    const formatted = formatTime(timerElapsed);
    sharedTimerData.displayTimer = formatted;
    sharedTimerData.elapsedTime = timerElapsed;
    broadcastToAll(sharedTimerData);
    const drift = timerElapsed % 1e3;
    timerInterval = setTimeout(tick, 1e3 - drift);
  }
  timerInterval = setTimeout(tick, 1e3);
});
ipcMain.on("timer-pause", () => {
  if (timerInterval) {
    clearTimeout(timerInterval);
    timerInterval = null;
  }
  sharedTimerData.isRunning = false;
  broadcastToAll(sharedTimerData);
});
ipcMain.on("timer-reset", () => {
  if (timerInterval) {
    clearTimeout(timerInterval);
    timerInterval = null;
  }
  timerElapsed = 0;
  timerStart = null;
  sharedTimerData.displayTimer = "00:00:00";
  sharedTimerData.elapsedTime = 0;
  sharedTimerData.isRunning = false;
  broadcastToAll(sharedTimerData);
});
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
  broadcastNonTimer(sharedTimerData);
});
ipcMain.on("add-session", (event, sessionData) => {
  sharedTimerData.sessions.push(sessionData);
  broadcastToAll(sharedTimerData);
});
ipcMain.on("open-analytics-window", () => {
  createAnalyticsWindow();
});
function createMainWindow() {
  const displays = screen.getAllDisplays();
  const targetDisplay = displays[0];
  const { x, y } = targetDisplay.bounds;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    x,
    y,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    resizable: false,
    maximizable: false
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.setPosition(x, y);
    mainWindow.show();
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
  const displays = screen.getAllDisplays();
  const targetDisplay = displays[1];
  const { x, y } = targetDisplay.bounds;
  if (analyticsWindow && !analyticsWindow.isDestroyed()) {
    return analyticsWindow;
  }
  analyticsWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    x,
    y,
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "Analytics Dashboard"
  });
  analyticsWindow.once("ready-to-show", () => {
    analyticsWindow.setPosition(x, y);
    console.log("Window title", analyticsWindow.getTitle());
    analyticsWindow.show();
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
ipcMain.on("quit-app", () => {
  app.quit();
});
app.whenReady().then(() => {
  createMainWindow();
});
app.on("before-quit", () => {
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => {
});
