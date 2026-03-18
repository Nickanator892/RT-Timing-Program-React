import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { spawn } from "child_process";
import http from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined;
const preloadPath = isDev
    ? path.join(process.cwd(), "electron", "preload.js")
    : path.join(__dirname, "preload.js");


let windows = [];
let mainWindow = null;
let analyticsWindow = null;
let serverProcess = null;

// Timer state owned by main process
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
    sessions: [],
};

// --------------------
// Server management
// --------------------
function startServer() {
    const serverPath = isDev
        ? path.join(process.cwd(), "src/backend/server.ts")
        : path.join(process.resourcesPath, "dist-server/server.js");

    const workerPath = isDev
        ? path.join(process.cwd(), "src/backend/db.worker.cjs")
        : path.join(process.resourcesPath, "dist-server/db.worker.cjs");

    const configPath = isDev
        ? path.join(process.cwd(), "db-config.json")
        : path.join(app.getPath("userData"), "db-config.json");

    const betterSqlitePath = isDev
    ? path.join(process.cwd(), "node_modules/better-sqlite3")
    : path.join(process.resourcesPath, "app.asar.unpacked/node_modules/better-sqlite3");



    const command = isDev ? "npx" : "node";
    const args = isDev ? ["tsx", serverPath] : [serverPath];

    const logPath = path.join(app.getPath("userData"), "server.log");
    fs.writeFileSync(logPath,
        `serverPath: ${serverPath}\n` +
        `workerPath: ${workerPath}\n` +
        `configPath: ${configPath}\n` +
        `serverPath exists: ${fs.existsSync(serverPath)}\n` +
        `workerPath exists: ${fs.existsSync(workerPath)}\n`
    );

    serverProcess = spawn(command, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
        env: { 
            ...process.env, 
            WORKER_PATH: workerPath,
            DB_CONFIG_PATH: configPath,
            BETTER_SQLITE3_PATH: betterSqlitePath
        }
    });

    serverProcess.stderr.on("data", (data) => fs.appendFileSync(logPath, `Server error: ${data.toString()}\n`));
    serverProcess.stdout.on("data", (data) => fs.appendFileSync(logPath, `Server: ${data.toString()}\n`));
    serverProcess.on("error", (err) => fs.appendFileSync(logPath, `Failed to start server: ${err}\n`));
    serverProcess.on("exit", (code) => fs.appendFileSync(logPath, `Server exited with code ${code}\n`));
}

function killExistingServer() {
    try {
        execSync("fuser -k 5000/tcp", { stdio: "ignore" });
    } catch {
        // No existing server, that's fine
    }
}

function stopServer() {
    if (serverProcess) {
        serverProcess.kill("SIGTERM");
        setTimeout(() => {
            if (serverProcess) {
                serverProcess.kill("SIGKILL");
                serverProcess = null;
            }
        }, 2000);
        serverProcess = null;
    }
}

// --------------------
// Broadcast helpers
// --------------------
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
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
        seconds
    ).padStart(2, "0")}`;
}

// --------------------
// Timer IPC handlers
// --------------------
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

        const drift = timerElapsed % 1000;
        timerInterval = setTimeout(tick, 1000 - drift);
    }

    timerInterval = setTimeout(tick, 1000);
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

// --------------------
// Shared data IPC handlers
// --------------------
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

// --------------------
// Window management
// --------------------
function createMainWindow() {
    const displays = screen.getAllDisplays();
    const targetDisplay = displays[0];
    const { x, y } = targetDisplay.bounds;
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        x: x,
        y: y,
        autoHideMenuBar: true,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
        resizable: false,
        maximizable: false,
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.setPosition(x, y)
        mainWindow.maximize()
        mainWindow.show()
    })

    windows.push(mainWindow);

    mainWindow.on("closed", () => {
        windows = windows.filter((w) => w !== mainWindow);
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
    const displays = screen.getAllDisplays();
    const targetDisplay = displays[0];
    const { x, y } = targetDisplay.bounds;
    if (analyticsWindow && !analyticsWindow.isDestroyed()) {
        return analyticsWindow;
    }

    analyticsWindow = new BrowserWindow({
        width: 1920,
        height: 1080,
        x: x,
        y: y,
        fullscreen: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
        title: `Analytics Dashboard`,
    });

    analyticsWindow.once("ready-to-show", () => {
        analyticsWindow.setPosition(x, y)
        analyticsWindow.maximize()
        analyticsWindow.show()
    })

    windows.push(analyticsWindow);

    analyticsWindow.on("closed", () => {
        windows = windows.filter((w) => w !== analyticsWindow);
        analyticsWindow = null;
    });

    if (process.env.VITE_DEV_SERVER_URL) {
        analyticsWindow.loadURL(process.env.VITE_DEV_SERVER_URL + "#/analytics");
        //analyticsWindow.webContents.openDevTools();
    } else {
        analyticsWindow.loadFile(path.join(__dirname, "../dist/index.html"), {
            hash: "analytics"
    });
    }

    return analyticsWindow;
}

// --------------------
// App lifecycle
// --------------------

ipcMain.on("quit-app", () => {
    app.quit();
});

function waitForServer(url, maxAttempts = 30, interval = 500) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        function attempt() {
            http.get(url, (res) => {
                resolve(); // server responded
            }).on("error", () => {
                attempts++;
                if (attempts >= maxAttempts) {
                    reject(new Error("Server did not start in time"));
                } else {
                    setTimeout(attempt, interval);
                }
            });
        }
        attempt();
    });
}

ipcMain.handle("run-updater", () => {
    spawn("npx", ["tsx", "/usr/local/rt-timing-updater/updater/update.ts"], {
        detached: true,
        stdio: "ignore",
        shell: true,
        cwd: "/usr/local/rt-timing-updater/updater"
    }).unref();
    setTimeout(() => {
        app.quit();
    }, 500);
});

app.whenReady().then(async () => {
    killExistingServer();
    startServer();
    try {
        await waitForServer("http://localhost:5000/api/db-status");
    } catch (e) {
        const logPath = path.join(app.getPath("userData"), "server.log");
        fs.appendFileSync(logPath, `Server never became ready: ${e}\n`);
    }
    createMainWindow();
});

app.on("before-quit", () => {
    stopServer();
});

app.on("window-all-closed", () => {
    stopServer();
    if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
    stopServer();
});
