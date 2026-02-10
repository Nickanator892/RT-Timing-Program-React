import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;
const preloadPath = isDev
    ? path.join(process.cwd(), "electron", "preload.js")
    : path.join(__dirname, "preload.js");

//console.log("Preload path:", preloadPath);
//console.log("Does it exist?", fs.existsSync(preloadPath));

const settingsPath = path.join(__dirname, "settings.json");

// Store all windows
let windows = [];
let mainWindow = null;
let analyticsWindow = null;

// Shared timer data
let sharedTimerData = {
    displayTimer: "00:00:00",
    activeButton: null,
    elapsedTime: 0,
    isRunning: false,
    selectedUser: null,
    pauseReason: [],
    currentSessionStart: null,
    sessions: [] // Historical session data for analytics
};

// IPC Handlers for settings
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

// Shared data IPC handlers
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
    // Merge new data with existing shared data
    sharedTimerData = { ...sharedTimerData, ...newData };
    
    // Broadcast to all windows
    windows.forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send("shared-data-changed", sharedTimerData);
        }
    });
});

// Add session data (when timer completes)
ipcMain.on("add-session", (event, sessionData) => {
    sharedTimerData.sessions.push(sessionData);
    
    // Broadcast to all windows
    windows.forEach(win => {
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
            nodeIntegration: false,
        },
        resizable: false,
        maximizable: false,
        center: true,
    });

    windows.push(mainWindow);

    mainWindow.on("closed", () => {
        windows = windows.filter(w => w !== mainWindow);
        mainWindow = null;
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
    }

    return mainWindow;
}

function createAnalyticsWindow() {
    // Don't create if already exists
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
            nodeIntegration: false,
        },
        title: "Analytics Dashboard",
    });

    windows.push(analyticsWindow);

    analyticsWindow.on("closed", () => {
        windows = windows.filter(w => w !== analyticsWindow);
        analyticsWindow = null;
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        analyticsWindow.loadURL(process.env.VITE_DEV_SERVER_URL + "#/analytics");
        analyticsWindow.webContents.openDevTools();
    } else {
        analyticsWindow.loadFile(path.join(__dirname, "../dist/index.html"));
        // After load, navigate to analytics route
        analyticsWindow.webContents.on("did-finish-load", () => {
            analyticsWindow.webContents.send("navigate-to", "/analytics");
        });
    }

    return analyticsWindow;
}

// Create analytics window on demand
ipcMain.on("open-analytics-window", () => {
    createAnalyticsWindow();
});

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});