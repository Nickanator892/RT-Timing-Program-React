import { ipcMain as i, BrowserWindow as v, screen as T, app as f } from "electron";
import a from "path";
import { fileURLToPath as D } from "url";
import E from "fs";
import { spawn as j } from "child_process";
const V = D(import.meta.url), y = a.dirname(V), w = process.env.VITE_DEV_SERVER_URL !== void 0, S = w ? a.join(process.cwd(), "electron", "preload.js") : a.join(y, "preload.js"), b = a.join(y, "settings.json");
let p = [], r = null, n = null, u = null, c = null, R = null, m = 0, s = {
  displayTimer: "00:00:00",
  activeButton: null,
  elapsedTime: 0,
  isRunning: !1,
  selectedUser: null,
  pauseReason: [],
  currentSessionStart: null,
  sessions: []
};
function x() {
  const t = w ? a.join(process.cwd(), "src/backend/server.ts") : a.join(process.resourcesPath, "dist-server/server.js"), e = w ? a.join(process.cwd(), "src/backend/db.worker.cjs") : a.join(process.resourcesPath, "dist-server/db.worker.cjs");
  u = j(w ? "npx" : "node", w ? ["tsx", t] : [t], {
    shell: !0,
    stdio: "ignore",
    windowsHide: !0,
    detached: !1,
    env: { ...process.env, WORKER_PATH: e }
  }), u.on("error", (l) => console.error("Failed to start server:", l)), u.on("exit", (l) => {
    console.log(`Server exited with code ${l}`), u = null;
  });
}
function _() {
  u && (u.kill("SIGTERM"), u = null);
}
function h(t) {
  p.forEach((e) => {
    e.isDestroyed() || e.webContents.send("shared-data-changed", t);
  });
}
let g = null;
function P(t) {
  g && clearTimeout(g), g = setTimeout(() => {
    h(t);
  }, 100);
}
function I(t) {
  const e = Math.floor(t / 1e3), o = Math.floor(e / 3600), d = Math.floor(e % 3600 / 60), l = e % 60;
  return `${String(o).padStart(2, "0")}:${String(d).padStart(2, "0")}:${String(
    l
  ).padStart(2, "0")}`;
}
i.on("timer-start", () => {
  if (c) return;
  R = Date.now() - m, s.isRunning = !0, h(s);
  function t() {
    m = Date.now() - R;
    const e = I(m);
    s.displayTimer = e, s.elapsedTime = m, h(s);
    const o = m % 1e3;
    c = setTimeout(t, 1e3 - o);
  }
  c = setTimeout(t, 1e3);
});
i.on("timer-pause", () => {
  c && (clearTimeout(c), c = null), s.isRunning = !1, h(s);
});
i.on("timer-reset", () => {
  c && (clearTimeout(c), c = null), m = 0, R = null, s.displayTimer = "00:00:00", s.elapsedTime = 0, s.isRunning = !1, h(s);
});
i.handle("read-settings", async () => {
  try {
    const t = E.readFileSync(b, "utf-8");
    return JSON.parse(t);
  } catch (t) {
    return console.error("Failed to read settings:", t), { pauseReasons: [] };
  }
});
i.handle("write-settings", async (t, e) => {
  try {
    return E.writeFileSync(b, JSON.stringify(e, null, 2)), { success: !0 };
  } catch (o) {
    return console.error("Failed to write settings:", o), { success: !1, error: o.message };
  }
});
i.handle("get-shared-data", () => s);
i.handle("get-window-type", (t) => {
  const e = v.fromWebContents(t.sender);
  return e === r ? "main" : e === n ? "analytics" : "unknown";
});
i.on("update-shared-data", (t, e) => {
  s = { ...s, ...e }, P(s);
});
i.on("add-session", (t, e) => {
  s.sessions.push(e), h(s);
});
i.on("open-analytics-window", () => {
  k();
});
function U() {
  const e = T.getAllDisplays()[0], { x: o, y: d } = e.bounds;
  return r = new v({
    width: 1280,
    height: 720,
    x: o,
    y: d,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: S,
      contextIsolation: !0,
      nodeIntegration: !1
    },
    resizable: !1,
    maximizable: !1
  }), r.once("ready-to-show", () => {
    r.setPosition(o, d), r.maximize(), r.show();
  }), p.push(r), r.on("closed", () => {
    p = p.filter((l) => l !== r), r = null;
  }), process.env.VITE_DEV_SERVER_URL ? r.loadURL(process.env.VITE_DEV_SERVER_URL) : r.loadFile(a.join(y, "../dist/index.html")), r;
}
function k() {
  const e = T.getAllDisplays()[0], { x: o, y: d } = e.bounds;
  return n && !n.isDestroyed() || (n = new v({
    width: 1920,
    height: 1080,
    x: o,
    y: d,
    fullscreen: !1,
    autoHideMenuBar: !0,
    webPreferences: {
      preload: S,
      contextIsolation: !0,
      nodeIntegration: !1
    },
    title: "Analytics Dashboard"
  }), n.once("ready-to-show", () => {
    n.setPosition(o, d), n.maximize(), n.show();
  }), p.push(n), n.on("closed", () => {
    p = p.filter((l) => l !== n), n = null;
  }), process.env.VITE_DEV_SERVER_URL ? n.loadURL(process.env.VITE_DEV_SERVER_URL + "#/analytics") : (n.loadFile(a.join(y, "../dist/index.html")), n.webContents.on("did-finish-load", () => {
    n.webContents.send("navigate-to", "/analytics");
  }))), n;
}
i.on("quit-app", () => {
  f.quit();
});
f.whenReady().then(() => {
  x(), U();
});
f.on("before-quit", () => {
  _();
});
f.on("window-all-closed", () => {
  process.platform !== "darwin" && f.quit();
});
f.on("will-quit", () => {
  _();
});
