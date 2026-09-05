import { app, BrowserWindow, ipcMain, screen } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { spawn, execSync } from "child_process";
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

// --------------------
// Crash-recovery heartbeat
// --------------------
// The app cannot know when it died, so while it is alive it periodically
// persists how much the current segment has earned. timerElapsed is already
// pause-free (timer-pause freezes it), so the persisted value needs no pause
// arithmetic: a crash costs at most one interval, and always UNDER-credits.
let currentSegmentId = null;
let segmentBase = 0;          // timerElapsed at the moment this segment opened
let heartbeatTimer = null;
let heartbeatTicks = 0;
const HEARTBEAT_MS = 60_000;        // while running
const PAUSED_EVERY_N_TICKS = 5;     // while paused, write every 5th tick (5 min)

function segmentSeconds() {
    return Math.max(0, Math.round((timerElapsed - segmentBase) / 1000));
}

/** Resolves { ok, error }. It reads the body rather than just the status code
 *  because /api/heartbeat answers 200 with {success:false} when the UPDATE
 *  itself failed - which is exactly the read-only-share case we have to see. */
function postJson(pathname, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = http.request(
            { host: "localhost", port: 5000, path: pathname, method: "POST",
              headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
              timeout: 8000 },
            (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => {
                    let parsed = null;
                    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
                    const httpOk = res.statusCode >= 200 && res.statusCode < 300;
                    if (httpOk && parsed?.success !== false) return resolve({ ok: true });
                    resolve({ ok: false, error: parsed?.error || `HTTP ${res.statusCode}` });
                });
            }
        );
        // Still fire-and-forget: a heartbeat failure reports itself, but it must
        // never throw into, or block, the timer.
        req.on("error", (e) => resolve({ ok: false, error: String(e?.message || e) }));
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timed out" }); });
        req.write(payload);
        req.end();
    });
}

// The heartbeat is the only proof the displayed time is being recorded at all.
// When it stops landing, the operator is watching a clock that is lying to them
// - so say so instead of swallowing it. One miss is a hiccup; two in a row is a
// problem worth interrupting someone over.
let heartbeatFailures = 0;
const HEARTBEAT_FAIL_LIMIT = 2;

function setHeartbeatError(message) {
    const next = message ?? null;
    if (sharedTimerData.heartbeatError === next) return;
    sharedTimerData.heartbeatError = next;
    try {
        if (next) {
            fs.appendFileSync(path.join(app.getPath("userData"), "server.log"),
                `Heartbeat write failing (${heartbeatFailures} consecutive): ${next}\n`);
        }
    } catch { /* logging must never break the timer */ }
    broadcastNonTimer(sharedTimerData);
}

async function writeHeartbeat() {
    if (!currentSegmentId) return false;
    const out = await postJson("/api/heartbeat", {
        segmentId: currentSegmentId,
        accumSeconds: segmentSeconds(),
        state: sharedTimerData.isRunning ? "RUN" : "PAUSE",
    });
    if (out.ok) {
        heartbeatFailures = 0;
        setHeartbeatError(null);
        return true;
    }
    heartbeatFailures++;
    if (heartbeatFailures >= HEARTBEAT_FAIL_LIMIT) setHeartbeatError(out.error || "unknown error");
    return false;
}

function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
        heartbeatTicks++;
        // A long pause does not need minute-by-minute writes to a network share,
        // but it must still refresh liveness so "paused since 3h ago and alive"
        // stays distinguishable from "died 3h ago".
        if (!sharedTimerData.isRunning && heartbeatTicks % PAUSED_EVERY_N_TICKS !== 0) return;
        writeHeartbeat();
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
}

let sharedTimerData = {
    displayTimer: "00:00:00",
    activeButton: null,
    elapsedTime: 0,
    isRunning: false,
    selectedUser: null,
    pauseReason: [],
    currentSessionStart: null,
    sessions: [],
    // Set once at boot by the recovery scan; null when there is nothing to
    // recover. Detection only - no database writes happen at boot.
    recovery: null,
    // Non-null while heartbeat writes are failing repeatedly: the timer is
    // running but nothing is reaching the database.
    heartbeatError: null,
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
    startHeartbeat();
    writeHeartbeat(); // transition: don't wait a full interval to record RUN

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
    // Freeze the earned total on disk at the instant of the pause, so a crash
    // during a pause credits exactly the work done before it.
    writeHeartbeat();
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
    // The build is submitted: stop heartbeating a segment that is now closed.
    stopHeartbeat();
    currentSegmentId = null;
    segmentBase = 0;
    heartbeatTicks = 0;
    heartbeatFailures = 0;
    // Nothing is being heartbeated any more, so the warning would just sit there
    // unable to clear itself. A failing submit reports itself on its own path.
    setHeartbeatError(null);
    sharedTimerData.recovery = null;
});

// The renderer tells main which segment is live, so heartbeats land on the
// right row. segmentBase makes the persisted value segment-local while
// timerElapsed stays build-scoped.
ipcMain.on("timer-segment", (_event, { segmentId, segmentAccumSeconds } = {}) => {
    currentSegmentId = segmentId ?? null;
    segmentBase = timerElapsed - Math.max(0, Number(segmentAccumSeconds) || 0) * 1000;
    heartbeatTicks = 0;
    if (currentSegmentId) {
        startHeartbeat();
        writeHeartbeat();
    }
});

// Restore an interrupted build: reproduce exactly the frozen state that
// timer-pause leaves behind, so the existing resume path works untouched.
ipcMain.handle("restore-timer", (_event, { elapsedMs, segmentId, segmentAccumSeconds } = {}) => {
    if (timerInterval) {
        clearTimeout(timerInterval);
        timerInterval = null;
    }
    timerElapsed = Math.max(0, Number(elapsedMs) || 0);
    timerStart = null;
    currentSegmentId = segmentId ?? null;
    segmentBase = timerElapsed - Math.max(0, Number(segmentAccumSeconds) || 0) * 1000;
    sharedTimerData.isRunning = false;
    sharedTimerData.elapsedTime = timerElapsed;
    sharedTimerData.displayTimer = formatTime(timerElapsed);
    broadcastToAll(sharedTimerData);
    startHeartbeat();
    return { ok: true };
});

// A candidate already restored into the running app is no longer something to
// offer. Without this, logging out and back in would find the same object again
// and - now that recovery is automatic - silently restore a build that may
// since have been submitted.
ipcMain.handle("get-recovery", () =>
    sharedTimerData.recovery && sharedTimerData.recovery.status !== "RESTORED"
        ? sharedTimerData.recovery
        : null
);

// Worked seconds for the CURRENT segment. The renderer needs this whenever it
// closes a segment (submit, builder change) so the stored value is exact rather
// than up to one heartbeat interval stale.
ipcMain.handle("get-segment-seconds", () => segmentSeconds());

// "Not now" - stop offering it for this session; the segment stays open and
// will be offered again next launch, because someone still has to deal with it.
ipcMain.on("dismiss-recovery", () => {
    sharedTimerData.recovery = null;
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
    if (process.platform !== "linux") {
        console.log("Updater only runs on Linux, skipping...");
        return;
    }
    spawn("lxterminal", ["-e", "npx tsx /usr/local/rt-timing-updater/updater/update.ts"], {
        detached: true,
        stdio: "ignore",
        shell: true,
        cwd: "/usr/local/rt-timing-updater/updater",
        env: {
            ...process.env,
            DISPLAY: ":0"
        }
    }).unref();
    setTimeout(() => {
        app.quit();
    }, 500);
});

/**
 * Look for a build this station left open. Runs in the main process, once per
 * launch, BEFORE any window exists - the two windows (main + analytics) both
 * mount the same React tree, so a renderer-side scan would run twice and race
 * itself. Detection only; nothing is written until the operator chooses.
 */
function scanForInterruptedBuild() {
    return new Promise((resolve) => {
        http.get({ host: "localhost", port: 5000, path: "/api/recovery/scan", timeout: 8000 }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed?.recovery ?? null);
                } catch {
                    resolve(null);
                }
            });
        }).on("error", () => resolve(null)).on("timeout", function () { this.destroy(); resolve(null); });
    });
}

function logRecovery(where) {
    if (!sharedTimerData.recovery) return;
    fs.appendFileSync(path.join(app.getPath("userData"), "server.log"),
        `Recovery candidate (${where}): build ${sharedTimerData.recovery.buildId} ` +
        `(${sharedTimerData.recovery.harnNumber}) status ${sharedTimerData.recovery.status}\n`);
}

/**
 * Keep looking after the first scan comes back empty.
 *
 * On a site-wide power cut the Pi is routinely up before the file server is,
 * and the boot scan then finds nothing at all - the operator logs in, sees no
 * unfinished build and starts a new one over the top of it. The login screen
 * re-polls, so a candidate found late still reaches them.
 */
async function retryRecoveryScan(attempts = 10, delayMs = 15000) {
    for (let i = 0; i < attempts; i++) {
        await new Promise((r) => setTimeout(r, delayMs));
        // Once a build is live, the only open segment is that build's own. It
        // must never be offered back to the operator as something to recover.
        if (currentSegmentId || sharedTimerData.recovery) return;
        try {
            const found = await scanForInterruptedBuild();
            if (found) {
                sharedTimerData.recovery = found;
                logRecovery(`late scan, attempt ${i + 1}`);
                broadcastNonTimer(sharedTimerData);
                return;
            }
        } catch { /* best-effort */ }
    }
}

app.whenReady().then(async () => {
    killExistingServer();
    startServer();
    try {
        await waitForServer("http://localhost:5000/api/db-status");
    } catch (e) {
        const logPath = path.join(app.getPath("userData"), "server.log");
        fs.appendFileSync(logPath, `Server never became ready: ${e}\n`);
    }
    try {
        sharedTimerData.recovery = await scanForInterruptedBuild();
        logRecovery("boot");
    } catch { /* recovery is best-effort; never block startup */ }
    createMainWindow();
    if (!sharedTimerData.recovery) retryRecoveryScan();
});

app.on("before-quit", async () => {
    // Last chance to record what this segment earned before the process dies.
    await writeHeartbeat();
    stopHeartbeat();
    stopServer();
});

app.on("window-all-closed", () => {
    stopServer();
    if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
    stopServer();
});
